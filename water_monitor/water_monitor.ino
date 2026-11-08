// ESP32 Water Monitor: TDS + pH (3-point calibration) + DS18B20 + Web Integration
// ทุกอย่างทำงานแบบ non-blocking ด้วย millis()
// Serial commands (115200): 1/2/3 = บันทึกจุดปรับเทียบ pH, c = ล้างค่า, s = ดูสถานะ

#include <OneWire.h>
#include <DallasTemperature.h>
#include <Preferences.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include "secrets.h"

// ---------------- Pins ----------------
#define TDS_PIN      35   // ADC1
#define PH_PIN       34   // ADC1
#define ONE_WIRE_BUS 4

// ---------------- Optional Relays (สำหรับระบบควบคุมฮีตเตอร์และไฟ) ----------------
#define RELAY_HEATER_PIN 26
#define RELAY_LIGHT_PIN  27

// ---------------- Wi-Fi Config ----------------
#define ENABLE_WIFI true                             // เปิดใช้งาน Wi-Fi (true = ส่งตรงขึ้นเว็บผ่าน Wi-Fi)
const char* WIFI_SSID     = AQUARIUM_WIFI_SSID;
const char* WIFI_PASSWORD = AQUARIUM_WIFI_PASSWORD;
const char* SERVER_URL    = AQUARIUM_SERVER_URL;
const char* API_KEY       = AQUARIUM_API_KEY;

// ---------------- Config ----------------
#define SCOUNT 30                       // จำนวนตัวอย่างต่อ buffer (median filter)
const unsigned long SAMPLE_INTERVAL_MS = 40;    // สุ่ม ADC ทุก 40 ms
const unsigned long REPORT_INTERVAL_MS = 1000;  // คำนวณ/พิมพ์ทุก 1 วินาที
const unsigned long TEMP_INTERVAL_MS   = 2000;  // ขออุณหภูมิทุก 2 วินาที
const unsigned long TEMP_CONVERT_MS    = 800;   // รอ DS18B20 แปลงค่า (12 bit ~750 ms)
const unsigned long WIFI_POST_INTERVAL = 3000;  // ยิง HTTP POST ทุก 3 วินาที

const float DIVIDER_GAIN = 1.0;   // ถ้ามีตัวแบ่งแรงดันที่ขา pH (เช่น 10k/10k) ใส่ 2.0
const float TDS_K        = 1.0;   // ตัวคูณปรับเทียบ TDS (ปรับทีหลังด้วยน้ำมาตรฐาน)
const float DEFAULT_TEMP = 25.0;  // ใช้เมื่ออ่านอุณหภูมิไม่ได้

// ค่า pH อ้างอิงของ 3 จุด
const float REF_PH[3] = {2.5, 6.8, 8.3};
const char* REF_NAME[3] = {"น้ำส้มสายชู (pH 2.5)", "น้ำกลั่น (pH 6.8)", "น้ำเบกกิ้งโซดา (pH 8.3)"};

// ---------------- Globals ----------------
OneWire oneWire(ONE_WIRE_BUS);
DallasTemperature tempSensor(&oneWire);
Preferences prefs;

int tdsBuf[SCOUNT];   // เก็บ mV
int phBuf[SCOUNT];    // เก็บ mV
int sampleIndex = 0;
int sampleCount = 0;

// pH calibration
float calV[3];
bool calDone[3] = {false, false, false};
float phSlope = 0, phIntercept = 0;
bool phCalibrated = false;

// ค่าล่าสุดสำหรับส่งเข้า Web Dashboard
float gTemp = DEFAULT_TEMP;
bool  gTempOk = false;
float gTds = 0;
float gPhVolt = 0;
float gPh = 0;
bool  gPhValid = false;

// temperature state
bool tempPending = false;
unsigned long tempRequestAt = 0;
unsigned long lastWifiPostAt = 0;
unsigned long lastWifiRetryAt = 0;
unsigned long uptimeSec = 0;

// ---------------- Helpers ----------------
int medianOf(const int *src, int len) {
  int tmp[SCOUNT];
  for (int i = 0; i < len; i++) tmp[i] = src[i];
  for (int i = 1; i < len; i++) {            // insertion sort
    int key = tmp[i], j = i - 1;
    while (j >= 0 && tmp[j] > key) { tmp[j + 1] = tmp[j]; j--; }
    tmp[j + 1] = key;
  }
  if (len & 1) return tmp[len / 2];
  return (tmp[len / 2] + tmp[len / 2 - 1]) / 2;
}

// แรงดัน pH (V) จาก median ของ buffer ปัจจุบัน
float phVoltageNow() {
  int n = sampleCount < SCOUNT ? sampleCount : SCOUNT;
  if (n == 0) return 0;
  return (medianOf(phBuf, n) / 1000.0) * DIVIDER_GAIN;
}

// ---------------- pH calibration ----------------
void computeFit() {
  int n = 0;
  float sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (int i = 0; i < 3; i++) {
    if (!calDone[i]) continue;
    n++;
    sx += calV[i];
    sy += REF_PH[i];
    sxx += calV[i] * calV[i];
    sxy += calV[i] * REF_PH[i];
  }
  if (n < 2) { phCalibrated = false; return; }
  float d = n * sxx - sx * sx;
  if (fabs(d) < 1e-6) { phCalibrated = false; return; }
  phSlope = (n * sxy - sx * sy) / d;
  phIntercept = (sy - phSlope * sx) / n;
  phCalibrated = true;
}

void saveCal() {
  prefs.begin("phcal", false);
  for (int i = 0; i < 3; i++) {
    prefs.putFloat(("v" + String(i)).c_str(), calV[i]);
    prefs.putBool(("d" + String(i)).c_str(), calDone[i]);
  }
  prefs.end();
}

void loadCal() {
  prefs.begin("phcal", true);
  for (int i = 0; i < 3; i++) {
    calV[i] = prefs.getFloat(("v" + String(i)).c_str(), 0);
    calDone[i] = prefs.getBool(("d" + String(i)).c_str(), false);
  }
  prefs.end();
  computeFit();
}

void printCalStatus() {
  Serial.println("--- สถานะการปรับเทียบ pH ---");
  for (int i = 0; i < 3; i++) {
    Serial.print(i + 1); Serial.print(") ");
    Serial.print(REF_NAME[i]); Serial.print(": ");
    if (calDone[i]) { Serial.print(calV[i], 3); Serial.println(" V"); }
    else Serial.println("ยังไม่ได้บันทึก");
  }
  if (phCalibrated) {
    Serial.print("pH = "); Serial.print(phSlope, 3);
    Serial.print(" * V + "); Serial.println(phIntercept, 3);
    if (phSlope >= 0) Serial.println("เตือน: ความชันควรติดลบ (V สูง = pH ต่ำ) เช็กลำดับสารละลาย");
  } else {
    Serial.println("ยังคำนวณไม่ได้ (ต้องบันทึกอย่างน้อย 2 จุด)");
  }
  Serial.println("----------------------------");
}

void handleSerial() {
  while (Serial.available()) {
    String line = Serial.readStringUntil('\n');
    line.trim();
    if (line.length() == 0) continue;

    char c = line[0];
    if (c >= '1' && c <= '3') {
      if (sampleCount < SCOUNT) {
        Serial.println("ยังเก็บตัวอย่างไม่ครบ รอสักครู่แล้วลองใหม่");
        continue;
      }
      int i = c - '1';
      Serial.print("กำลังบันทึก "); Serial.println(REF_NAME[i]);
      calV[i] = phVoltageNow();
      calDone[i] = true;
      computeFit();
      saveCal();
      printCalStatus();
    } else if (c == 'c') {
      for (int i = 0; i < 3; i++) calDone[i] = false;
      phCalibrated = false;
      saveCal();
      Serial.println("ล้างค่าปรับเทียบแล้ว");
    } else if (c == 's') {
      printCalStatus();
    } else if (line.startsWith("CMD:")) {
      int firstColon = line.indexOf(':');
      int secondColon = line.indexOf(':', firstColon + 1);
      if (secondColon > 0) {
        String dev = line.substring(firstColon + 1, secondColon);
        String action = line.substring(secondColon + 1);
        if (dev == "heater") {
          if (action == "ON" && (gTemp >= 30.0 || !gTempOk)) {
            Serial.println("[ESP32 Failsafe] ปฏิเสธการเปิดฮีตเตอร์ (Overheat/Sensor Error)");
          } else {
            digitalWrite(RELAY_HEATER_PIN, action == "ON" ? HIGH : LOW);
            Serial.println("[ESP32 Relay] Heater -> " + action);
          }
        } else if (dev == "light") {
          digitalWrite(RELAY_LIGHT_PIN, action == "ON" ? HIGH : LOW);
          Serial.println("[ESP32 Relay] Light -> " + action);
        }
      }
    }
  }
}

// ---------------- Sampling ----------------
void sampleADC() {
  static unsigned long last = 0;
  if (millis() - last < SAMPLE_INTERVAL_MS) return;
  last = millis();
  tdsBuf[sampleIndex] = analogReadMilliVolts(TDS_PIN);
  phBuf[sampleIndex]  = analogReadMilliVolts(PH_PIN);
  sampleIndex = (sampleIndex + 1) % SCOUNT;
  if (sampleCount < SCOUNT) sampleCount++;
}

// ---------------- Temperature (non-blocking) ----------------
void updateTemperature() {
  static unsigned long lastRequest = 0;
  if (!tempPending) {
    if (millis() - lastRequest >= TEMP_INTERVAL_MS) {
      tempSensor.requestTemperatures();
      tempRequestAt = millis();
      lastRequest = millis();
      tempPending = true;
    }
  } else if (millis() - tempRequestAt >= TEMP_CONVERT_MS) {
    float t = tempSensor.getTempCByIndex(0);
    if (t == DEVICE_DISCONNECTED_C || t < -50) {
      gTempOk = false;
      gTemp = DEFAULT_TEMP;               // fallback
    } else {
      gTempOk = true;
      gTemp = t;
    }
    tempPending = false;
  }
}

// ---------------- Compute + report ----------------
void updateReadings() {
  static unsigned long last = 0;
  if (millis() - last < REPORT_INTERVAL_MS) return;
  last = millis();
  uptimeSec++;
  if (sampleCount < SCOUNT) return;   // รอ buffer เต็มก่อน

  // TDS (ชดเชยอุณหภูมิ)
  float v = (medianOf(tdsBuf, SCOUNT) / 1000.0);
  float comp = v / (1.0 + 0.02 * (gTemp - 25.0));
  gTds = (133.42 * comp * comp * comp - 255.86 * comp * comp + 857.39 * comp) * 0.5 * TDS_K;
  if (gTds < 0) gTds = 0;

  // pH
  gPhVolt = phVoltageNow();
  gPhValid = phCalibrated;
  if (phCalibrated) {
    gPh = phSlope * gPhVolt + phIntercept;
  }

  // คำนวณค่า pH สำหรับแสดงผล (หากยังไม่ได้ Calibrate ให้ใช้ค่าประมาณการจากแรงดัน Po)
  float displayPh = gPhValid ? gPh : (7.0 - (gPhVolt - 2.5) * 3.5);
  if (displayPh < 0.0) displayPh = 0.0;
  if (displayPh > 14.0) displayPh = 14.0;

  // 1. พิมพ์สรุปสำหรับ Arduino Serial Monitor แบบดั้งเดิม
  Serial.print("Temp: ");
  if (gTempOk) { Serial.print(gTemp, 1); Serial.print(" C"); }
  else Serial.print("N/A (ใช้ 25 C)");
  Serial.print(" | TDS: "); Serial.print(gTds, 0); Serial.print(" ppm");
  Serial.print(" | Po: "); Serial.print(gPhVolt, 3); Serial.print(" V");
  Serial.print(" | pH: ");
  if (gPhValid) Serial.print(gPh, 2);
  else Serial.print("ยังไม่ปรับเทียบ");
  if (gPhVolt > 3.1) Serial.print("  [เตือน: Po สูงเกิน 3.1 V]");
  Serial.println();

  // 2. พิมพ์ JSON สำหรับ Web Serial / Serial Bridge
  Serial.print("{\"type\":\"water_data\",\"temp\":");
  Serial.print(gTempOk ? gTemp : DEFAULT_TEMP, 2);
  Serial.print(",\"tds\":");
  Serial.print(gTds, 1);
  Serial.print(",\"ph\":");
  Serial.print(displayPh, 2);
  Serial.print(",\"phVolt\":");
  Serial.print(gPhVolt, 3);
  Serial.print(",\"phValid\":");
  Serial.print(gPhValid ? "true" : "false");
  Serial.print(",\"tempOk\":");
  Serial.print(gTempOk ? "true" : "false");
  Serial.println("}");
}

// ---------------- Wi-Fi HTTP Post ----------------
void sendToWebServer() {
#if ENABLE_WIFI
  if (WiFi.status() != WL_CONNECTED) {
    // พยายามเชื่อมต่อใหม่ถ้า Wi-Fi หลุด (ทุก 10 วินาที)
    if (millis() - lastWifiRetryAt >= 10000) {
      lastWifiRetryAt = millis();
      Serial.println("[Wi-Fi] พยายามเชื่อมต่อ Wi-Fi อีกครั้ง...");
      WiFi.disconnect();
      WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
    }
    return;
  }

  if (millis() - lastWifiPostAt < WIFI_POST_INTERVAL) return;
  lastWifiPostAt = millis();

  WiFiClient client;
  WiFiClientSecure secureClient;
  HTTPClient http;
  http.setTimeout(4000);

  const bool useHttps = String(SERVER_URL).startsWith("https://");
  if (useHttps) {
    if (strlen(AQUARIUM_ROOT_CA) == 0) {
      Serial.println("⚠️ [Wi-Fi HTTPS] กรุณาตั้งค่า AQUARIUM_ROOT_CA ใน secrets.h ก่อน");
      return;
    }
    secureClient.setCACert(AQUARIUM_ROOT_CA);
  }

  const bool requestStarted = useHttps
    ? http.begin(secureClient, SERVER_URL)
    : http.begin(client, SERVER_URL);
  if (!requestStarted) {
    Serial.println("⚠️ [Wi-Fi HTTP] ไม่สามารถเริ่มต้นการเชื่อมต่อไปยัง SERVER_URL ได้");
    return;
  }

  http.addHeader("Content-Type", "application/json");
  http.addHeader("X-API-KEY", API_KEY);

  float displayPh = gPhValid ? gPh : (7.0 - (gPhVolt - 2.5) * 3.5);
  displayPh = constrain(displayPh, 0.0, 14.0);

  String payload = "{";
  payload += "\"temp\":" + String(gTempOk ? gTemp : DEFAULT_TEMP, 2) + ",";
  payload += "\"tds\":" + String((int)gTds) + ",";
  payload += "\"ph\":" + String(displayPh, 2) + ",";
  payload += "\"turbidityRaw\":1400,";
  payload += "\"sensorOk\":{\"temp\":" + String(gTempOk ? "true" : "false") + ",\"ph\":true,\"tds\":true,\"turbidity\":true},";
  payload += "\"rssi\":" + String(WiFi.RSSI()) + ",";
  payload += "\"uptimeSec\":" + String(uptimeSec);
  payload += "}";

  int httpCode = http.POST(payload);
  if (httpCode == HTTP_CODE_OK || httpCode == 200) {
    Serial.println("🌐 [Wi-Fi HTTP] ส่งข้อมูลขึ้นเว็บสำเร็จ! (HTTP 200 OK)");
    String res = http.getString();
    // Parse commands returned from server if needed
  } else {
    Serial.print("⚠️ [Wi-Fi HTTP Error] ล้มเหลว Code: ");
    Serial.print(httpCode);
    Serial.print(" (");
    Serial.print(http.errorToString(httpCode));
    Serial.println(")");
    if (httpCode < 0) {
      Serial.print("   -> ตรวจสอบว่า IP: ");
      Serial.print(SERVER_URL);
      Serial.println(" ถูกต้องและคอมพิวเตอร์เปิด node server.js อยู่");
    }
  }
  http.end();
#endif
}

// ---------------- Arduino Setup & Loop ----------------
void setup() {
  Serial.begin(115200);
  analogSetPinAttenuation(TDS_PIN, ADC_11db);
  analogSetPinAttenuation(PH_PIN, ADC_11db);

  pinMode(RELAY_HEATER_PIN, OUTPUT);
  pinMode(RELAY_LIGHT_PIN, OUTPUT);
  digitalWrite(RELAY_HEATER_PIN, LOW);
  digitalWrite(RELAY_LIGHT_PIN, LOW);

  tempSensor.begin();
  tempSensor.setWaitForConversion(false);

  loadCal();
  Serial.println("==================================================");
  Serial.println("🐠 ESP32 Water Monitor: TDS + pH + Temp (AUCC 2026)");
  Serial.println("คำสั่ง Serial: 1/2/3 = บันทึกจุด pH, c = ล้างค่า, s = ดูสถานะ");
  printCalStatus();
  Serial.println("==================================================");

#if ENABLE_WIFI
  Serial.print("กำลังเชื่อมต่อ Wi-Fi: ");
  Serial.println(WIFI_SSID);
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  // รอเชื่อมต่อ Wi-Fi ไม่เกิน 10 วินาที
  unsigned long startWifi = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - startWifi < 10000) {
    delay(500);
    Serial.print(".");
  }
  Serial.println();

  if (WiFi.status() == WL_CONNECTED) {
    Serial.print("✅ เชื่อมต่อ Wi-Fi สำเร็จ! IP บอร์ด ESP32: ");
    Serial.println(WiFi.localIP());
    Serial.print("📡 ส่งข้อมูลไปยัง Server: ");
    Serial.println(SERVER_URL);
  } else {
    Serial.println("⚠️ ยังเชื่อมต่อ Wi-Fi ไม่สำเร็จ (จะพยายามเชื่อมต่อใหม่ในพื้นหลัง)");
    Serial.println("   -> ตรวจสอบชื่อ SSID และ Password อีกครั้ง");
  }
  Serial.println("==================================================");
#endif
}

void loop() {
  handleSerial();
  sampleADC();
  updateTemperature();
  updateReadings();
#if ENABLE_WIFI
  sendToWebServer();
#endif
}
