/* ============================================================================
   SERVIDOR DASHBOARD TANQUE ESP32 (Express + MySQL) - CONSULTAS HISTÓRICAS
   ============================================================================ */

const express = require('express');
const mysql = require('mysql2');
const session = require('express-session');
const bodyParser = require('body-parser');
const path = require('path');

const app = express();
const PORT = 3000;
const HOST = '0.0.0.0';

const CFG = {
    NIVEL_MAX: 13.0,          
    NIVEL_MIN: 8.0,           
    ALTURA_TANQUE: 19.8,      
    RESIDUO_FONDO: 2.4,       
    TOLERANCIA: 2.0,
    MAX_DELTA_SALTO: 4.0,
    MILIS_DESCONEXION: 5000,

    PID_SETPOINT: 12.0,       
    NIVEL_MIN_HISTERESIS: 8.0, 
    PID_KP: 25.0,             
    PID_KI: 0.5,              
    PID_KD: 2.0,              
    PID_SALIDA_MIN: 0.0,      
    PID_SALIDA_MAX: 100.0,

    BANDA_MINIMA_CM: 0.5,       
    TIMEOUT_APROX_MS: 45000,    
    TIEMPO_MIN_CICLO_MS: 8000,  
    MIN_SUBE_CM: 0.3            
};

const DB_CONFIG = {
    host: 'localhost',
    user: 'root',
    password: 'S12345678',  
    database: 'tanquepid'
};

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});

app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
    secret: 'clave_secreta_proyecto',
    resave: false,
    saveUninitialized: true
}));

const db = mysql.createPool({
    ...DB_CONFIG,
    waitForConnections: true,
    connectionLimit: 10
});

// Detección automática de la columna de fecha/hora en las tablas MySQL
let colFechaMediciones = 'fecha_hora';
let colFechaAuditoria = 'fecha_hora';

function detectarColumnasFecha() {
    db.query('SHOW COLUMNS FROM mediciones_tanque', (err, rows) => {
        if (!err && Array.isArray(rows)) {
            const cols = rows.map(r => r.Field);
            const candidata = ['fecha_hora', 'fecha', 'created_at', 'timestamp', 'hora_fecha'].find(c => cols.includes(c));
            if (candidata) colFechaMediciones = candidata;
        }
    });
    db.query('SHOW COLUMNS FROM auditoria_usuarios', (err, rows) => {
        if (!err && Array.isArray(rows)) {
            const cols = rows.map(r => r.Field);
            const candidata = ['fecha_hora', 'fecha', 'created_at', 'timestamp', 'hora_fecha'].find(c => cols.includes(c));
            if (candidata) colFechaAuditoria = candidata;
        }
    });
}
detectarColumnasFecha();

function formatearFechaSQL(val) {
    if (!val) return null;
    const d = new Date(val);
    if (isNaN(d.getTime())) return String(val);
    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

let estadoSistema = {
    sistemaIniciado: false,
    nivel_cm: 0,
    lectura_ultra: null,
    sensor_ok: false,
    hay_flujo: false,
    estado_bomba: false,
    estado_bomba_aux: false,
    modo_manual: false,
    comando_bomba_manual: false,
    ultimoNivelRegistrado: -999,
    ultimoReporte: 0,
    totalPeticiones: 0,
    ultimaPeticionIP: null,
    ultimaRaw: null,
    veredicto: 'SIN_DATOS',
    coherencia: 'SIN_DATOS',
    deltaUltra: null,
    tendencia: 'ESTABLE',
    mensajeValidacion: '',
    nivelPrevio: null,
    historialNiveles: [],

    modo_control: 'HIBRIDO',                 
    setpoint: CFG.PID_SETPOINT,
    nivel_min_histeresis: CFG.NIVEL_MIN_HISTERESIS, 
    kp: CFG.PID_KP,
    ki: CFG.PID_KI,
    kd: CFG.PID_KD,
    salida_pid: 0,                       
    error_pid: 0,

    config_version: 1,                    
    parametros_esp32: {},                 

    nivelRegistrado: null,                
    dbEstado: 'OK',                       
    dbUltimoError: null,
    dbUltimoRegistro: 0,
    registrosInsertados: 0,
    ultimoIntentoRegistro: 0,

    bombaPrevia: false,
    inicioCicloMs: 0,
    nivelInicioCiclo: null,
    ultimoCorteMs: 0,
    ultimoCorteMotivo: '',
    estancada: false,
    segSinSubir: 0,
    bandaOk: true,
};

function calcularTendencia(nivel) {
    const h = estadoSistema.historialNiveles;
    h.push(nivel);
    while (h.length > 6) h.shift();
    if (h.length < 2) return 'ESTABLE';
    const delta = h[h.length - 1] - h[0];
    if (delta > 0.2) return 'SUBIENDO';
    if (delta < -0.2) return 'BAJANDO';
    return 'ESTABLE';
}

function evaluarCoherencia(ultra, nivel, sensorOk, tendencia, estadoBomba) {
    if (sensorOk === false) return { estado: 'SENSOR_NO_FIABLE', delta: null, tendencia, mensaje: 'Sensor no confiable.' };
    if (ultra === null || ultra === undefined || isNaN(ultra)) return { estado: 'SIN_ULTRA', delta: null, tendencia, mensaje: 'Sin lectura ultrasónica.' };
    const delta = ultra - nivel;
    if (Math.abs(delta) > CFG.TOLERANCIA) return { estado: 'INCOHERENTE', delta, tendencia, mensaje: 'Incoherencia entre ultra y nivel.' };
    return { estado: 'OK', delta, tendencia, mensaje: 'Lectura coherente y física consistente.' };
}

function registrarPorCentimetro(nivel) {
    if (!isFinite(nivel)) return;

    if (estadoSistema.nivelRegistrado === null) {
        estadoSistema.nivelRegistrado = Math.round(nivel);
        insertarMedicion(nivel, 'INICIO');
        return;
    }

    const anterior = estadoSistema.nivelRegistrado;
    const objetivo = (nivel > anterior) ? Math.floor(nivel) : Math.ceil(nivel);

    if (objetivo === anterior) return;      

    estadoSistema.nivelRegistrado = objetivo;
    const direccion = (objetivo > anterior) ? 'SUBE' : 'BAJA';
    const cuantos = Math.abs(objetivo - anterior);

    insertarMedicion(nivel, direccion + ' ' + anterior + '→' + objetivo + (cuantos > 1 ? ' (x' + cuantos + ')' : ''));
}

function insertarMedicion(nivel, motivo) {
    estadoSistema.ultimoIntentoRegistro = Date.now();

    const cols = ['nivel_cm', 'lectura_ultra', 'hay_flujo', 'estado_bomba', 'salida_pid', 'setpoint'];
    const vals = [Number(nivel.toFixed(2)), estadoSistema.lectura_ultra,
                  estadoSistema.hay_flujo, estadoSistema.estado_bomba,
                  estadoSistema.salida_pid, estadoSistema.setpoint];

    const hacerInsert = (conMotivo) => {
        const c = conMotivo ? cols.concat(['motivo']) : cols;
        const v = conMotivo ? vals.concat([motivo]) : vals;
        const sql = 'INSERT INTO mediciones_tanque (' + c.join(',') + ') VALUES (' + c.map(() => '?').join(',') + ')';
        db.query(sql, v, (err, result) => {
            if (err) {
                if (conMotivo && /motivo/i.test(err.message || '')) return hacerInsert(false);
                estadoSistema.dbEstado = 'ERROR';
                estadoSistema.dbUltimoError = err.message;
                return;
            }
            estadoSistema.dbEstado = 'OK';
            estadoSistema.dbUltimoError = null;
            estadoSistema.dbUltimoRegistro = Date.now();
            estadoSistema.registrosInsertados = (estadoSistema.registrosInsertados || 0) + 1;
            estadoSistema.ultimoRegistroMotivo = motivo;
            if (result && result.insertId) estadoSistema.ultimoIdRegistrado = result.insertId;
        });
    };

    hacerInsert(true);
}

app.get('/api/db-status', (req, res) => {
    db.query('SELECT 1', (err) => {
        if (err) {
            res.json({ conectado: false, ...DB_CONFIG, error: err.message });
        } else {
            res.json({ conectado: true, ...DB_CONFIG, error: null });
        }
    });
});

app.post('/api/telemetria', (req, res) => {
    estadoSistema.totalPeticiones++;
    estadoSistema.ultimaPeticionIP = req.ip;
    estadoSistema.ultimaRaw = req.body;

    const body = req.body || {};
    const nivelRaw = body.nivel_cm ?? body.nivel ?? 0;
    const ultraRaw = body.lectura_ultra ?? body.ultra ?? null;
    const sensorOkRaw = body.sensor_ok ?? true;

    const nivel = parseFloat(nivelRaw) || 0;
    const ultra = (ultraRaw === null || ultraRaw === undefined) ? null : parseFloat(ultraRaw);
    const sensorOk = Boolean(sensorOkRaw);

    estadoSistema.nivel_cm = nivel;
    estadoSistema.lectura_ultra = isNaN(ultra) ? null : ultra;
    estadoSistema.sensor_ok = sensorOk;
    estadoSistema.ultimoReporte = Date.now();

    if (body.modo_manual !== undefined) {
        estadoSistema.modo_manual = Boolean(body.modo_manual);
    }

    const tendencia = calcularTendencia(nivel);
    estadoSistema.tendencia = tendencia;

    const ev = evaluarCoherencia(estadoSistema.lectura_ultra, nivel, sensorOk, tendencia, estadoSistema.estado_bomba);
    estadoSistema.veredicto = ev.estado;
    estadoSistema.coherencia = ev.estado;
    estadoSistema.deltaUltra = ev.delta;
    estadoSistema.mensajeValidacion = ev.mensaje;

    const espejoESP32 = {};
    ['setpoint', 'nivel_min_histeresis', 'kp', 'ki', 'kd'].forEach((k) => {
        const v = parseFloat(body[k]);
        if (!isNaN(v)) espejoESP32[k] = v;
    });
    estadoSistema.parametros_esp32 = espejoESP32;

    if (!estadoSistema.sistemaIniciado) {
        estadoSistema.estado_bomba = false;
        estadoSistema.estado_bomba_aux = false;
        estadoSistema.modo_manual = false;
        estadoSistema.comando_bomba_manual = false;
        estadoSistema.salida_pid = 0;
    } else if (estadoSistema.modo_manual) {
        estadoSistema.modo_control = 'MANUAL';
        estadoSistema.estado_bomba = estadoSistema.comando_bomba_manual;
        estadoSistema.salida_pid = estadoSistema.comando_bomba_manual ? 100 : 0;
    } else {
        estadoSistema.modo_control = 'HIBRIDO';
        const datoObedece = (ev.estado === 'OK' || ev.estado === 'INCOHERENTE');

        let bomba = estadoSistema.estado_bomba;
        const spObj = Number(estadoSistema.setpoint);
        const minHist = Number(estadoSistema.nivel_min_histeresis);

        if (nivel >= spObj) {
            bomba = false;
        } else if (nivel <= minHist) {
            bomba = true;
        }

        if (nivel >= CFG.NIVEL_MAX) { 
            bomba = false; 
        }

        let salida = bomba ? 100.0 : 0.0;
        estadoSistema.salida_pid = salida;
        estadoSistema.estado_bomba = bomba;
        estadoSistema.hay_flujo = bomba;
        estadoSistema.estado_bomba_aux = (datoObedece && nivel < (minHist - 3.0));

        const ahoraMs = Date.now();
        if (!estadoSistema.bombaPrevia && bomba) {
            estadoSistema.inicioCicloMs = ahoraMs;
            estadoSistema.nivelInicioCiclo = nivel;
            estadoSistema.ultimoCorteMotivo = '';
            estadoSistema.estancada = false;
        }

        if (!bomba && estadoSistema.bombaPrevia) {
            estadoSistema.ultimoCorteMs = ahoraMs;
            if (nivel >= spObj) {
                estadoSistema.ultimoCorteMotivo = 'Llegó al setpoint (' + spObj.toFixed(1) + ' cm)';
            } else if (nivel <= (minHist + 0.3)) {
                estadoSistema.ultimoCorteMotivo = 'Corte por mínimo de histéresis';
            } else {
                estadoSistema.ultimoCorteMotivo = 'Corte del equipo a ' + nivel.toFixed(1) + ' cm';
            }
        }

        estadoSistema.bombaPrevia = bomba;
    }

    estadoSistema.nivelPrevio = nivel;

    if (sensorOk) {
        registrarPorCentimetro(nivel);
    }

    res.json({
        ok: true,
        sistema_iniciado: estadoSistema.sistemaIniciado,
        modo_manual: estadoSistema.modo_manual,
        comando_bomba_manual: estadoSistema.comando_bomba_manual,
        bomba_recomendada: estadoSistema.estado_bomba,
        setpoint: estadoSistema.setpoint,
        nivel_min_histeresis: estadoSistema.nivel_min_histeresis,
        kp: estadoSistema.kp,
        ki: estadoSistema.ki,
        kd: estadoSistema.kd,
        config_version: estadoSistema.config_version,
        salida_pid: estadoSistema.salida_pid,
        veredicto: ev.estado,
        coherencia: ev.estado,
        mensaje: ev.mensaje
    });
});

app.get('/api/debug', (req, res) => {
    res.json({
        conectado: (Date.now() - estadoSistema.ultimoReporte) < CFG.MILIS_DESCONEXION,
        estadoSistema
    });
});

app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    db.query('SELECT * FROM usuarios WHERE username = ? AND password = ?', [username, password], (err, results) => {
        if (err || results.length === 0) return res.status(401).json({ error: 'Credenciales inválidas' });
        const user = results[0];
        req.session.user = user;
        res.json({ username: user.username, rol: user.rol || 'admin' });
    });
});

app.post('/api/control', (req, res) => {
    if (!req.session.user) return res.status(403).json({ error: 'No autorizado' });
    const { accion, valor } = req.body;
    if (accion === 'iniciar_sistema') {
        estadoSistema.sistemaIniciado = valor;
        if (valor) {
            estadoSistema.nivelRegistrado = null;   
            estadoSistema.bombaPrevia = false;
            estadoSistema.inicioCicloMs = 0;
            estadoSistema.ultimoCorteMotivo = '';
        }
    } else if (accion === 'modo_manual') {
        estadoSistema.modo_manual = valor;
    } else if (accion === 'bomba_manual') {
        estadoSistema.comando_bomba_manual = valor;
        estadoSistema.estado_bomba = valor;
    }
    res.json({ ok: true, estadoSistema });
});

app.post('/api/pid', (req, res) => {
    if (!req.session.user) return res.status(403).json({ error: 'No autorizado' });
    if (req.session.user.rol === 'invitado') return res.status(403).json({ error: 'Invitados sin acceso' });

    const body = req.body || {};
    const avisos = [];

    const hayValor = (v) => (v !== undefined && v !== null && v !== '' && !isNaN(parseFloat(v)));

    let sp = hayValor(body.setpoint) ? parseFloat(body.setpoint) : Number(estadoSistema.setpoint);
    if (sp < 5.0) { sp = 5.0; avisos.push('Setpoint llevado al mínimo de 5.0 cm'); }
    if (sp > CFG.NIVEL_MAX) { sp = CFG.NIVEL_MAX; avisos.push('Setpoint llevado al máximo de ' + CFG.NIVEL_MAX + ' cm'); }

    let minH = hayValor(body.nivel_min_histeresis) ? parseFloat(body.nivel_min_histeresis) : Number(estadoSistema.nivel_min_histeresis);
    if (minH < 1.0) { minH = 1.0; avisos.push('Arranque llevado al mínimo de 1.0 cm'); }
    if (minH > sp - 0.2) {
        minH = Math.round((sp - 0.2) * 10) / 10;
        avisos.push('Arranque ajustado a ' + minH.toFixed(1) + ' cm');
    }

    estadoSistema.setpoint = Math.round(sp * 10) / 10;
    estadoSistema.nivel_min_histeresis = Math.round(minH * 10) / 10;

    if (hayValor(body.kp)) estadoSistema.kp = parseFloat(body.kp);
    if (hayValor(body.ki)) estadoSistema.ki = parseFloat(body.ki);
    if (hayValor(body.kd)) estadoSistema.kd = parseFloat(body.kd);

    estadoSistema.config_version++;   

    db.query('INSERT INTO auditoria_usuarios (usuario, accion) VALUES (?, ?)',
        [req.session.user.username,
         `Config: SP=${estadoSistema.setpoint} MinHist=${estadoSistema.nivel_min_histeresis}`]);

    res.json({ 
        ok: true, 
        setpoint: estadoSistema.setpoint, 
        nivel_min_histeresis: estadoSistema.nivel_min_histeresis,
        kp: estadoSistema.kp, 
        ki: estadoSistema.ki, 
        kd: estadoSistema.kd,
        config_version: estadoSistema.config_version,
        avisos: avisos
    });
});

app.post('/api/limpiar-registros', (req, res) => {
    if (!req.session.user || req.session.user.rol === 'invitado') return res.status(403).json({ error: 'No autorizado' });
    db.query('DELETE FROM mediciones_tanque', () => {
        estadoSistema.nivelRegistrado = null;      
        estadoSistema.registrosInsertados = 0;
        db.query('DELETE FROM auditoria_usuarios', () => {
            res.json({ ok: true });
        });
    });
});

app.get('/api/estado', (req, res) => {
    res.json({
        estadoSistema,
        diagnosticoRegistro: {
            estado: estadoSistema.dbEstado,
            error: estadoSistema.dbUltimoError,
            ultimoRegistro: estadoSistema.dbUltimoRegistro,
            insertados: estadoSistema.registrosInsertados,
            motivo: estadoSistema.ultimoRegistroMotivo || null,
            nivelRegistrado: estadoSistema.nivelRegistrado
        },
        diagnosticoCiclo: {
            bomba: estadoSistema.estado_bomba,
            inicioCicloMs: estadoSistema.inicioCicloMs,
            ultimoCorteMs: estadoSistema.ultimoCorteMs,
            motivo: estadoSistema.ultimoCorteMotivo,
            segSinSubir: estadoSistema.segSinSubir,
            estancada: estadoSistema.estancada,
            bandaOk: (Number(estadoSistema.setpoint) - Number(estadoSistema.nivel_min_histeresis)) >= (CFG.BANDA_MINIMA_CM || 1.0),
            faltante: Math.round((Number(estadoSistema.setpoint) - estadoSistema.nivel_cm) * 10) / 10
        },
        usuario: req.session.user || null
    });
});

// ============================================================================
// ENDPOINT DE REGISTROS CON FILTRO TEMPORAL Y FORMATEO DE FECHA/HORA
// ============================================================================
app.get('/api/registros', (req, res) => {
    const rango = req.query.rango || 'realtime';
    const semanas = Math.max(1, parseInt(req.query.semanas, 10) || 1);
    const mes = parseInt(req.query.mes, 10); // 1 a 12
    const anio = parseInt(req.query.anio, 10) || new Date().getFullYear();

    const col = colFechaMediciones;
    let where = '';
    let params = [];
    let limit = 'LIMIT 500';

    switch (rango) {
        case '1h':
            where = `WHERE ${col} >= NOW() - INTERVAL 1 HOUR`;
            limit = 'LIMIT 2000';
            break;
        case '2h':
            where = `WHERE ${col} >= NOW() - INTERVAL 2 HOUR`;
            limit = 'LIMIT 3000';
            break;
        case '3h':
            where = `WHERE ${col} >= NOW() - INTERVAL 3 HOUR`;
            limit = 'LIMIT 4000';
            break;
        case 'hoy':
            where = `WHERE DATE(${col}) = CURDATE()`;
            limit = 'LIMIT 5000';
            break;
        case 'ayer':
            where = `WHERE DATE(${col}) = CURDATE() - INTERVAL 1 DAY`;
            limit = 'LIMIT 5000';
            break;
        case 'semana_anterior':
            where = `WHERE ${col} >= NOW() - INTERVAL ? WEEK`;
            params.push(semanas);
            limit = 'LIMIT 8000';
            break;
        case 'mes_actual':
            if (!isNaN(mes) && mes >= 1 && mes <= 12) {
                where = `WHERE MONTH(${col}) = ? AND YEAR(${col}) = ?`;
                params.push(mes, anio);
            } else {
                where = `WHERE MONTH(${col}) = MONTH(CURDATE()) AND YEAR(${col}) = YEAR(CURDATE())`;
            }
            limit = 'LIMIT 10000';
            break;
        case 'mes_anterior':
            where = `WHERE YEAR(${col}) = YEAR(CURDATE() - INTERVAL 1 MONTH) AND MONTH(${col}) = MONTH(CURDATE() - INTERVAL 1 MONTH)`;
            limit = 'LIMIT 10000';
            break;
        case 'definir_mes':
            if (!isNaN(mes) && mes >= 1 && mes <= 12) {
                where = `WHERE MONTH(${col}) = ? AND YEAR(${col}) = ?`;
                params.push(mes, anio);
            }
            limit = 'LIMIT 10000';
            break;
        default:
            where = '';
            limit = 'LIMIT 500';
            break;
    }

    const sql = `SELECT * FROM mediciones_tanque ${where} ORDER BY id DESC ${limit}`;
    db.query(sql, params, (err, rows) => {
        if (err) {
            console.error('Error consulta mediciones:', err.message);
            return res.json([]);
        }
        const normalizados = (rows || []).map(r => {
            const rawFecha = r.fecha_hora || r.fecha || r.created_at || r.timestamp || r.hora_fecha || null;
            return {
                ...r,
                fecha_hora: formatearFechaSQL(rawFecha) || 'Sin fecha'
            };
        });
        res.json(normalizados);
    });
});

app.get('/api/auditoria', (req, res) => {
    db.query('SELECT * FROM auditoria_usuarios ORDER BY id DESC LIMIT 500', (err, rows) => {
        const normalizados = (rows || []).map(r => {
            const rawFecha = r.fecha_hora || r.fecha || r.created_at || r.timestamp || r.hora_fecha || null;
            return {
                ...r,
                fecha_hora: formatearFechaSQL(rawFecha) || 'Sin fecha'
            };
        });
        res.json(normalizados);
    });
});

app.listen(PORT, HOST, () => {
    console.log(`==================================================`);
    console.log(` Servidor iniciado en http://${HOST}:${PORT}`);
    console.log(` Conectado a MySQL [Base de datos: ${DB_CONFIG.database}]`);
    console.log(`==================================================`);
});