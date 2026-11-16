# tanquepid — Control PID del tanque IoT (ESP32 + Node/Express + MySQL)

Este proyecto es una copia del proyecto del tanque de agua, en la que el **control
de la bomba por histéresis** (ON≤8 cm / OFF≥13 cm) se sustituye por un **control
PID** con salida continua (PWM 0–100 %). Se conserva **toda** la funcionalidad
anterior: login/roles, auditoría, registro de mediciones en MySQL, validación
cruzada ultrasonido↔nivel, modo manual, iniciar/detener, limpiar BD y el
dashboard web.

## Archivos

| Archivo | Descripción |
|---|---|
| `Server.js` | Servidor Node/Express. Es la **fuente del setpoint y las ganancias**, calcula un PID "sombra", guarda `salida_pid` y `setpoint` en MySQL y expone `/api/pid`. BD: `tanquepid`. |
| `TanqueESP32_PID.ino` | Firmware ESP32. El PID corre **en tiempo real** en el micro y acciona la bomba por **PWM (LEDC)** en vez de ON/OFF. |
| `index.html` | Dashboard con un nuevo **panel PID** (setpoint, Kp, Ki, Kd, botón Aplicar) y lecturas de salida % y error. |
| `esquema.sql` | Base `tanquepid` con `usuarios`, `mediciones_tanque` (ahora con `salida_pid` y `setpoint`) y `auditoria_usuarios`. |

## Puesta en marcha

1. `mysql -u root -p < esquema.sql`
2. `npm install express mysql2 express-session body-parser` y `node Server.js`
3. Cargar `TanqueESP32_PID.ino` en el ESP32 (ajustar WiFi y `serverUrl`).
4. Abrir el dashboard, iniciar sesión y usar el panel **Control PID**.

---

## Qué cambia al pasar de histéresis a PID

### Histéresis (antes)
La bomba era **todo o nada**. Con una banda 8–13 cm:
- se enciende al llegar a 8 cm y se apaga al llegar a 13 cm;
- el nivel **oscila** siempre entre los dos umbrales (nunca se queda quieto);
- la bomba hace **ciclos ON/OFF** frecuentes (más desgaste y arranques);
- un solo parámetro de ajuste: los dos umbrales.

### PID (ahora)
La bomba trabaja a **velocidad variable** (PWM 0–100 %) para mantener el nivel en
un **setpoint** fijo (por defecto **10,5 cm**, dentro de la banda 8–13).
La salida se calcula con:

```
salida(%) = Kp·e + Ki·∫e·dt + Kd·(de/dt)      con   e = setpoint − nivel
```

- **P (Kp)** reacciona al error actual: cuanto más lejos del setpoint, más empuja
  la bomba. Sube la rapidez, pero por sí solo deja un pequeño error permanente.
- **I (Ki)** acumula el error en el tiempo y **elimina ese error permanente**
  (lleva el nivel exactamente al setpoint). Lleva **anti-windup** para no
  saturar.
- **D (Kd)** reacciona a la **velocidad de cambio** del nivel y **frena** antes
  de pasarse, reduciendo el sobreimpulso y las oscilaciones.

**Ganancias por defecto:** `Kp = 12`, `Ki = 0,8`, `Kd = 4`, salida limitada a
0–100 %.

### Reparto de responsabilidades
- **ESP32:** ejecuta el PID real y aplica la salida por **PWM (LEDC, canal 0, 1 kHz,
  8 bits)** sobre el pin de la bomba.
- **Servidor:** define el **setpoint y las ganancias** (editables en caliente desde
  el dashboard vía `/api/pid`), calcula un PID "sombra" para telemetría y **registra**
  `salida_pid` y `setpoint` en cada medición.
- **Seguridad:** la antigua banda **8–13 cm se conserva como CLAMP**: si el nivel
  alcanza 13 cm la salida se fuerza a 0 y se reinicia el integral; si el sensor
  falla, la bomba no actúa a ciegas.

### Ventajas prácticas
- Nivel **estable en el setpoint**, sin la oscilación obligatoria de la histéresis.
- **Menos arranques** y funcionamiento más suave de la bomba.
- Ajuste fino en marcha (setpoint y Kp/Ki/Kd) sin reprogramar el ESP32.

### Qué NO se tocó
- Botones y sus funciones (iniciar/detener, manual, limpiar BD, pestañas).
- Login, roles, auditoría y validación cruzada ultrasonido↔nivel.
- Pines y saneo del sensor; la banda 8–13 cm sigue presente, ahora como seguridad.
