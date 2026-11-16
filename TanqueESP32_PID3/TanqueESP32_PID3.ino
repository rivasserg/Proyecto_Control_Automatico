/* ============================================================================
   TANQUE ESP32 — Control Híbrido (Histéresis Exacta + Potencia Plena al Setpoint)
   ============================================================================ */

#include <Arduino.h>
#include <WiFi.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <Wire.h>
#include <LiquidCrystal_I2C.h>
#include <math.h>

#ifndef M_PI
#define M_PI 3.14159265358979323846
#endif

const char* ssid     = "proyecto";
const char* password = "12345678";

IPAddress local_IP(192, 168, 1, 250);
IPAddress gateway(192, 168, 1, 1);
IPAddress subnet(255, 255, 255, 0);
IPAddress primaryDNS(8, 8, 8, 8);

const char* serverUrl = "http://192.168.1.249:3000/api/telemetria";

const int trigPin      = 23; 
const int echoPin      = 22; 
const int pumpPin      = 21; 
const int pumpAuxPin   = 27; 
const int ledWifiGreen = 19; 
const int ledWifiRed   = 18; 
const int ledSistemaOn = 12; 
const int ledSistemaOff= 14; 

const int i2cSdaPin    = 25; 
const int i2cSclPin    = 26; 
LiquidCrystal_I2C lcd(0x27, 20, 4); 

const float ALTURA_TANQUE_CM     = 19.8; 
const float RESIDUO_FONDO_CM     =  2.4; 
const float NIVEL_MAX_ABSOLUTO   = 13.0; // Límite físico de seguridad

// Variables globales actualizables dinámicamente desde el Dashboard
float pidSetpoint         = 12.0; // 👈 Nivel donde la bomba completa el ciclo y se APAGA
float nivelMinHisteresis  =  8.0; // 👈 Nivel mínimo donde la bomba vuelve a ARRANCAR
float pidKp               = 25.0;                  
float pidKi               =  0.5;                   
float pidKd               =  2.0;                   

const float SALIDA_MAX_PCT = 100.0;
const float SALIDA_MIN_PCT = 0.0;

const unsigned long TIMEOUT_APROX_MS = 90000; 
const float MIN_SUBE_CM        = 0.30;
const float BANDA_MINIMA_BANDA = 1.00;

bool  avisoEstancada    = false;   
unsigned long inicioCicloMs    = 0;
float nivelInicioCiclo         = -1.0;

int configVersionLocal = 0;

const int   PWM_FREQ       = 1000;   
const int   PWM_RESOLUCION = 8;      
const int   PWM_DUTY_MAX   = 255;

unsigned long pidPrevMs = 0;
float globalSalidaPID = 0.0;         

const int   MEDIANA_MUESTRAS     = 5;    
const float MAX_SALTO_CM         = 4.0;   
const unsigned long TIMEOUT_ECO_US = 30000; 

bool sistemaIniciado = false;  

SemaphoreHandle_t mutexGlobales;
float globalNivelL          = 0.0;   
float globalUltraCruda      = 0.0;   
bool  globalSensorOk        = false; 
bool  globalEstadoBomba     = false;
bool  globalEstadoBombaAux  = false;
bool  globalModoManual      = false;
bool  globalComandoBombaManual = false;

TaskHandle_t TaskRed;

float leerDistanciaCruda() {
    digitalWrite(trigPin, LOW);
    delayMicroseconds(2);
    digitalWrite(trigPin, HIGH);
    delayMicroseconds(10);
    digitalWrite(trigPin, LOW);

    long duracion = pulseIn(echoPin, HIGH, TIMEOUT_ECO_US);
    if (duracion <= 0) return -1.0;              

    float distancia = (duracion * 0.0343) / 2.0; 
    if (distancia <= 0.5 || distancia > (ALTURA_TANQUE_CM + 10.0)) return -1.0;
    return distancia;
}

float filtrarOutliersYPromediar(float* arr, int n) {
    if (n < 3) {
        float sum = 0;
        for(int i = 0; i < n; i++) sum += arr[i];
        return sum / n;
    }

    for (int i = 1; i < n; i++) {
        float key = arr[i];
        int j = i - 1;
        while (j >= 0 && arr[j] > key) { arr[j + 1] = arr[j]; j--; }
        arr[j + 1] = key;
    }

    float sumaCentro = 0;
    int countCentro = 0;
    for (int i = 1; i < n - 1; i++) {
        sumaCentro += arr[i];
        countCentro++;
    }

    return sumaCentro / countCentro;
}

float nivelEstabilizadoAnterior = -1.0;

bool leerNivelSaneadoConFisica(float &nivelOut, float &ultraOut, bool bombaActiva) {
    float muestras[MEDIANA_MUESTRAS];
    int validas = 0;

    for (int i = 0; i < MEDIANA_MUESTRAS; i++) {
        float d = leerDistanciaCruda();
        if (d > 0) muestras[validas++] = d;
        delay(20); 
    }
    
    if (validas < (MEDIANA_MUESTRAS / 2 + 1)) return false;

    float distanciaFiltrada = filtrarOutliersYPromediar(muestras, validas);
    float nivelRealFisico = ALTURA_TANQUE_CM - distanciaFiltrada; 

    if (nivelRealFisico < RESIDUO_FONDO_CM) nivelRealFisico = RESIDUO_FONDO_CM;
    if (nivelRealFisico > ALTURA_TANQUE_CM) nivelRealFisico = ALTURA_TANQUE_CM;

    if (nivelEstabilizadoAnterior > 0) {
        float delta = nivelRealFisico - nivelEstabilizadoAnterior;
        if (bombaActiva && delta < -0.1) {
            nivelRealFisico = nivelEstabilizadoAnterior;
        }
        if (fabs(delta) > 0.3) {
            nivelRealFisico = nivelEstabilizadoAnterior + (delta > 0 ? 0.3 : -0.3);
        }
    }

    nivelEstabilizadoAnterior = nivelRealFisico;
    ultraOut = distanciaFiltrada;
    nivelOut = nivelRealFisico; 
    return true;
}

/* ============================================================================
   LÓGICA HÍBRIDA DE CONTROL (HISTÉRESIS EXACTA)
   ============================================================================ */
bool decidirBombaHibrida(float nivel, bool estadoActual, bool sensorOk) {
    if (!sensorOk) return estadoActual;

    unsigned long ahora = millis();

    // 1. APAGADO EXACTO: Se apaga al llegar o superar el setpoint (ej. 12.0 cm)
    if (nivel >= pidSetpoint) {
        inicioCicloMs   = ahora;
        nivelInicioCiclo = -1.0;
        return false;
    }

    // 2. ARRANQUE EXACTO: Vuelve a encender al bajar al mínimo de histéresis (ej. 8.0 cm)
    if (nivel <= nivelMinHisteresis) {
        inicioCicloMs   = ahora;
        nivelInicioCiclo = nivel;
        return true;
    }

    // 3. Supervisión de estancamiento (informativo)
    if (estadoActual) {
        if (nivelInicioCiclo < 0) { inicioCicloMs = ahora; nivelInicioCiclo = nivel; }
        unsigned long lleva = ahora - inicioCicloMs;
        if (lleva > TIMEOUT_APROX_MS && (nivel - nivelInicioCiclo) < MIN_SUBE_CM) {
            avisoEstancada = true;
        } else {
            avisoEstancada = false;
        }
    } else {
        avisoEstancada = false;
    }

    // Protección de seguridad absoluta
    if (nivel >= NIVEL_MAX_ABSOLUTO) {
        return false;
    }

    return estadoActual;
}

void codigoTareaRed(void * pvParameters) {
    for (;;) {
        if (WiFi.status() == WL_CONNECTED) {
            digitalWrite(ledWifiGreen, HIGH);
            digitalWrite(ledWifiRed, LOW);

            float tempNivel, tempUltra, tempSalida;
            bool  tempSensorOk, tempBomba, tempBombaAux, tempManual, tempSistemaOn;

            xSemaphoreTake(mutexGlobales, portMAX_DELAY);
            tempNivel     = globalNivelL;
            tempUltra     = globalUltraCruda;
            tempSensorOk  = globalSensorOk;
            tempBomba     = globalEstadoBomba;
            tempBombaAux  = globalEstadoBombaAux;
            tempManual    = globalModoManual;
            tempSistemaOn = sistemaIniciado;
            tempSalida    = globalSalidaPID;
            xSemaphoreGive(mutexGlobales);

            if (!tempSistemaOn) {
                tempBomba = false;
                tempBombaAux = false;
            }

            HTTPClient http;
            http.begin(serverUrl);
            http.addHeader("Content-Type", "application/json");

            StaticJsonDocument<400> doc;
            doc["ip"]                   = "192.168.1.250";
            doc["nivel_cm"]             = tempNivel;
            doc["lectura_ultra"]        = tempUltra;
            doc["sensor_ok"]            = tempSensorOk;
            doc["hay_flujo"]            = tempBomba;
            doc["estado_bomba"]         = tempBomba;
            doc["estado_bomba_aux"]     = tempBombaAux;
            doc["modo_manual"]          = tempManual;
            doc["sistema_iniciado"]     = tempSistemaOn;
            doc["salida_pid"]           = tempSalida;
            doc["centimetro"]           = (int)floor(globalNivelL);
            doc["setpoint"]             = pidSetpoint;
            doc["nivel_min_histeresis"] = nivelMinHisteresis;
            doc["kp"]                   = pidKp;
            doc["ki"]                   = pidKi;
            doc["kd"]                   = pidKd;

            String jsonOutput;
            serializeJson(doc, jsonOutput);

            int httpResponseCode = http.POST(jsonOutput);
            if (httpResponseCode > 0) {
                String response = http.getString();
                StaticJsonDocument<400> resDoc;
                DeserializationError error = deserializeJson(resDoc, response);
                if (!error) {
                    xSemaphoreTake(mutexGlobales, portMAX_DELAY);
                    if (resDoc.containsKey("sistema_iniciado"))
                        sistemaIniciado = resDoc["sistema_iniciado"];
                    if (resDoc.containsKey("modo_manual"))
                        globalModoManual = resDoc["modo_manual"];
                    if (resDoc.containsKey("comando_bomba_manual"))
                        globalComandoBombaManual = resDoc["comando_bomba_manual"];

                    int versionServidor = resDoc.containsKey("config_version")
                                          ? resDoc["config_version"].as<int>() : configVersionLocal;
                    if (versionServidor != configVersionLocal) {
                        if (resDoc.containsKey("setpoint"))             pidSetpoint = resDoc["setpoint"];
                        if (resDoc.containsKey("nivel_min_histeresis")) nivelMinHisteresis = resDoc["nivel_min_histeresis"];
                        if (resDoc.containsKey("kp"))                   pidKp = resDoc["kp"];
                        if (resDoc.containsKey("ki"))                   pidKi = resDoc["ki"];
                        if (resDoc.containsKey("kd"))                   pidKd = resDoc["kd"];
                        if (pidSetpoint < 5.0f)  pidSetpoint = 5.0f;
                        if (pidSetpoint > NIVEL_MAX_ABSOLUTO) pidSetpoint = NIVEL_MAX_ABSOLUTO;
                        if (nivelMinHisteresis < 1.0f) nivelMinHisteresis = 1.0f;
                        if (nivelMinHisteresis > pidSetpoint - BANDA_MINIMA_BANDA) nivelMinHisteresis = pidSetpoint - BANDA_MINIMA_BANDA;
                        configVersionLocal = versionServidor;
                    }
                    xSemaphoreGive(mutexGlobales);
                }
            }
            http.end();
        } else {
            digitalWrite(ledWifiGreen, LOW);
            digitalWrite(ledWifiRed, HIGH);
            WiFi.reconnect();
        }

        vTaskDelay(1000 / portTICK_PERIOD_MS);
    }
}

void setup() {
    Serial.begin(115200);
    delay(500);

    mutexGlobales = xSemaphoreCreateMutex();

    Wire.begin(i2cSdaPin, i2cSclPin);
    lcd.init();
    lcd.backlight();
    lcd.setCursor(0, 0);
    lcd.print("Iniciando Sistema...");

    pinMode(trigPin, OUTPUT);
    pinMode(echoPin, INPUT);
    pinMode(pumpPin, OUTPUT);
    pinMode(pumpAuxPin, OUTPUT);

    digitalWrite(pumpPin, HIGH);
    digitalWrite(pumpAuxPin, LOW);

    pinMode(ledWifiGreen, OUTPUT);
    pinMode(ledWifiRed, OUTPUT);
    pinMode(ledSistemaOn, OUTPUT);
    pinMode(ledSistemaOff, OUTPUT);

    if (!ledcAttach(pumpPin, PWM_FREQ, PWM_RESOLUCION)) {
        Serial.println("Error al inicializar PWM en pumpPin");
    }
    ledcWrite(pumpPin, PWM_DUTY_MAX);

    WiFi.config(local_IP, gateway, subnet, primaryDNS);
    WiFi.begin(ssid, password);

    xTaskCreatePinnedToCore(codigoTareaRed, "TaskRed", 10000, NULL, 1, &TaskRed, 0);
    delay(1000);
}

float nivelPrevio = -999.0;

void loop() {
    bool sistemaLocal;
    xSemaphoreTake(mutexGlobales, portMAX_DELAY);
    sistemaLocal = sistemaIniciado;
    bool bombaPrevia = globalEstadoBomba;
    xSemaphoreGive(mutexGlobales);

    digitalWrite(ledSistemaOn,  sistemaLocal ? HIGH : LOW);
    digitalWrite(ledSistemaOff, sistemaLocal ? LOW  : HIGH);

    float nivelSaneado = 0;
    float ultraCruda = 0;
    bool  sensorOk = leerNivelSaneadoConFisica(nivelSaneado, ultraCruda, bombaPrevia);

    if (!sensorOk) {
        xSemaphoreTake(mutexGlobales, portMAX_DELAY);
        nivelSaneado = globalNivelL;
        ultraCruda   = globalUltraCruda;
        xSemaphoreGive(mutexGlobales);
    } else {
        if (nivelPrevio > -900 && fabs(nivelSaneado - nivelPrevio) > MAX_SALTO_CM) {
            sensorOk = false;
            xSemaphoreTake(mutexGlobales, portMAX_DELAY);
            nivelSaneado = globalNivelL;
            ultraCruda   = globalUltraCruda;
            xSemaphoreGive(mutexGlobales);
        } else {
            nivelPrevio = nivelSaneado;
        }
    }

    bool estadoBombaActual    = false;
    bool estadoBombaAuxActual = false;
    bool modoManualLocal = false;
    bool cmdManualLocal  = false;

    xSemaphoreTake(mutexGlobales, portMAX_DELAY);
    modoManualLocal = globalModoManual;
    cmdManualLocal  = globalComandoBombaManual;
    xSemaphoreGive(mutexGlobales);

    if (sistemaLocal) {
        if (modoManualLocal) {
            estadoBombaActual    = cmdManualLocal;
            estadoBombaAuxActual = false;
        } else {
            estadoBombaActual    = decidirBombaHibrida(nivelSaneado, bombaPrevia, sensorOk);
            estadoBombaAuxActual = (sensorOk && nivelSaneado < (nivelMinHisteresis - 3.0));
            
            if (nivelSaneado >= NIVEL_MAX_ABSOLUTO) {
                estadoBombaActual = false;
            }
        }
    } else {
        estadoBombaActual    = false;
        estadoBombaAuxActual = false;
    }

    // Potencia al 100% cuando la bomba debe estar encendida para garantizar llegar al setpoint
    float salidaPID = 0.0;
    if (sistemaLocal) {
        if (modoManualLocal) {
            salidaPID = cmdManualLocal ? SALIDA_MAX_PCT : SALIDA_MIN_PCT;
        } else if (estadoBombaActual) {
            salidaPID = SALIDA_MAX_PCT; // 100% potencia para evitar estancamientos
            if (!sensorOk) { salidaPID = SALIDA_MIN_PCT; }
        } else {
            salidaPID = SALIDA_MIN_PCT;
        }
    } else {
        salidaPID = SALIDA_MIN_PCT;
    }

    int duty = (int)((salidaPID / 100.0) * PWM_DUTY_MAX);
    if (duty < 0)   duty = 0;
    if (duty > PWM_DUTY_MAX) duty = PWM_DUTY_MAX;

    int dutyInvertido = PWM_DUTY_MAX - duty;
    
    ledcWrite(pumpPin, dutyInvertido);
    digitalWrite(pumpAuxPin, estadoBombaAuxActual ? HIGH : LOW);

    xSemaphoreTake(mutexGlobales, portMAX_DELAY);
    globalNivelL         = nivelSaneado;
    globalUltraCruda     = ultraCruda;
    globalSensorOk       = sensorOk;
    globalEstadoBomba    = estadoBombaActual;
    globalEstadoBombaAux = estadoBombaAuxActual;
    globalSalidaPID      = salidaPID;
    xSemaphoreGive(mutexGlobales);

    // ================= PANTALLA LCD 20x4 =================
    char linea[21];

    if (sistemaLocal) {
        snprintf(linea, sizeof(linea), "SYS:ON %s",
                 (WiFi.status() == WL_CONNECTED) ? "WIFI:OK     " : "WIFI:SIN RED");
    } else {
        snprintf(linea, sizeof(linea), "SYS:OFF STANDBY     ");
    }
    lcd.setCursor(0, 0);
    lcd.print(linea);

    snprintf(linea, sizeof(linea), "Niv:%4.1f SP:%4.1f cm",
             nivelSaneado, pidSetpoint);
    lcd.setCursor(0, 1);
    lcd.print(linea);

    {
        bool ledActivo = (duty > 0);   
        snprintf(linea, sizeof(linea), "Bomba:%-3s LED:%-5s",
                 estadoBombaActual ? "ON" : "OFF",
                 ledActivo ? "ACT" : "INACT");
        lcd.setCursor(0, 2);
        lcd.print(linea);
    }

    {
        int pwmPct = (int)((salidaPID < 0) ? 0 : ((salidaPID > 100) ? 100 : salidaPID + 0.5));
        snprintf(linea, sizeof(linea), "PWM:%3d%% Sens:%-5s",
                 pwmPct, sensorOk ? "OK" : "ERROR");
        lcd.setCursor(0, 3);
        lcd.print(linea);
    }

    if (avisoEstancada) {
        digitalWrite(ledSistemaOn, (millis() / 500) % 2 ? HIGH : LOW);
    }

    delay(500); 
}