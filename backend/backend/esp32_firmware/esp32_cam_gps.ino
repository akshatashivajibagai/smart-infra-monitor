/**
 * CivicWatch IoT Edge Node Firmware
 * Hardware: AI-Thinker ESP32-CAM + NEO-6M GPS Module (UART on GPIO 14 RX / GPIO 15 TX)
 *
 * Captures JPEG frames via OV2640 camera, reads live NMEA coordinates & UTC timestamp
 * from NEO-6M GPS via TinyGPSPlus, and transmits a multipart/form-data HTTP POST
 * payload to the CivicWatch FastAPI backend (/api/v1/telemetry/ingest).
 *
 * IMPORTANT HARDWARE NOTE:
 * On AI-Thinker ESP32-CAM, GPIO 14 and GPIO 15 are shared with the SD_MMC slot.
 * Keep the microSD card removed and do not initialize SD_MMC so HardwareSerial(1)
 * can cleanly read the NEO-6M GPS module on GPIO 14 (RX) and GPIO 15 (TX).
 */

#include "esp_camera.h"
#include "soc/soc.h"
#include "soc/rtc_cntl_reg.h"
#include <WiFi.h>
#include <HTTPClient.h>
#include <TinyGPSPlus.h>

// ---------------------------------------------------------------------------
// Network & Backend Configuration
// ---------------------------------------------------------------------------
const char* WIFI_SSID     = "YOUR_WIFI_SSID";
const char* WIFI_PASSWORD = "YOUR_WIFI_PASSWORD";

// Replace with your CivicWatch backend host/IP (e.g., http://192.168.1.50:8000/api/v1/telemetry/ingest)
const char* INGEST_URL    = "http://192.168.1.50:8000/api/v1/telemetry/ingest";
const char* DEVICE_ID     = "ESP32-CAM-BLR-01";

// Capture & upload interval in milliseconds (15 seconds)
const unsigned long TELEMETRY_INTERVAL_MS = 15000UL;

// Fallback coordinates (Bengaluru MG Road) used ONLY when testing indoors without GPS satellite lock.
// Set REQUIRE_VALID_GPS_FIX to true in field deployments to suppress uploads without a live GPS fix.
#define REQUIRE_VALID_GPS_FIX false
const double FALLBACK_LAT = 12.975600;
const double FALLBACK_LON = 77.606600;

// ---------------------------------------------------------------------------
// AI-Thinker ESP32-CAM Pin Mapping
// ---------------------------------------------------------------------------
#define PWDN_GPIO_NUM     32
#define RESET_GPIO_NUM    -1
#define XCLK_GPIO_NUM      0
#define SIOD_GPIO_NUM     26
#define SIOC_GPIO_NUM     27

#define Y9_GPIO_NUM       35
#define Y8_GPIO_NUM       34
#define Y7_GPIO_NUM       39
#define Y6_GPIO_NUM       36
#define Y5_GPIO_NUM       21
#define Y4_GPIO_NUM       19
#define Y3_GPIO_NUM       18
#define Y2_GPIO_NUM        5
#define VSYNC_GPIO_NUM    25
#define HREF_GPIO_NUM     23
#define PCLK_GPIO_NUM     22

#define FLASH_LED_PIN      4
#define STATUS_LED_PIN    33

// ---------------------------------------------------------------------------
// NEO-6M GPS Configuration (GPIO 14 = ESP32 RX <- GPS TX, GPIO 15 = ESP32 TX -> GPS RX)
// ---------------------------------------------------------------------------
#define GPS_RX_PIN        14
#define GPS_TX_PIN        15
#define GPS_BAUD_RATE   9600

TinyGPSPlus gps;
HardwareSerial GPSSerial(1);

unsigned long lastTelemetryMillis = 0;

// ---------------------------------------------------------------------------
// Helper Functions
// ---------------------------------------------------------------------------

void blinkStatusLed(int times, int durationMs) {
  for (int i = 0; i < times; i++) {
    digitalWrite(STATUS_LED_PIN, LOW);   // Active LOW on AI-Thinker ESP32-CAM
    delay(durationMs);
    digitalWrite(STATUS_LED_PIN, HIGH);
    delay(durationMs);
  }
}

void feedGps(unsigned long durationMs) {
  unsigned long start = millis();
  while (millis() - start < durationMs) {
    while (GPSSerial.available() > 0) {
      gps.encode(GPSSerial.read());
    }
    delay(5);
  }
}

bool initCamera() {
  camera_config_t config;
  config.ledc_channel = LEDC_CHANNEL_0;
  config.ledc_timer   = LEDC_TIMER_0;
  config.pin_d0       = Y2_GPIO_NUM;
  config.pin_d1       = Y3_GPIO_NUM;
  config.pin_d2       = Y4_GPIO_NUM;
  config.pin_d3       = Y5_GPIO_NUM;
  config.pin_d4       = Y6_GPIO_NUM;
  config.pin_d5       = Y7_GPIO_NUM;
  config.pin_d6       = Y8_GPIO_NUM;
  config.pin_d7       = Y9_GPIO_NUM;
  config.pin_xclk     = XCLK_GPIO_NUM;
  config.pin_pclk     = PCLK_GPIO_NUM;
  config.pin_vsync    = VSYNC_GPIO_NUM;
  config.pin_href     = HREF_GPIO_NUM;
  config.pin_sccb_sda = SIOD_GPIO_NUM;
  config.pin_sccb_scl = SIOC_GPIO_NUM;
  config.pin_pwdn     = PWDN_GPIO_NUM;
  config.pin_reset    = RESET_GPIO_NUM;
  config.xclk_freq_hz = 20000000;
  config.pixel_format = PIXFORMAT_JPEG;

  if (psramFound()) {
    config.frame_size   = FRAMESIZE_SVGA;  // 800x600 optimal balance for CV inference & bandwidth
    config.jpeg_quality = 12;              // 0-63 lower is higher quality
    config.fb_count     = 2;
    config.grab_mode    = CAMERA_GRAB_LATEST;
  } else {
    config.frame_size   = FRAMESIZE_VGA;   // 640x480 fallback without PSRAM
    config.jpeg_quality = 15;
    config.fb_count     = 1;
    config.grab_mode    = CAMERA_GRAB_WHEN_EMPTY;
  }

  esp_err_t err = esp_camera_init(&config);
  if (err != ESP_OK) {
    Serial.printf("[CAM] Camera initialization failed: 0x%x\n", err);
    return false;
  }

  sensor_t* s = esp_camera_sensor_get();
  if (s != nullptr) {
    s->set_brightness(s, 0);
    s->set_contrast(s, 1);
    s->set_saturation(s, 0);
    s->set_whitebal(s, 1);
    s->set_awb_gain(s, 1);
    s->set_exposure_ctrl(s, 1);
    s->set_aec2(s, 1);
  }

  Serial.println("[CAM] OV2640 initialized successfully.");
  return true;
}

void ensureWiFiConnected() {
  if (WiFi.status() == WL_CONNECTED) {
    return;
  }

  Serial.printf("[WIFI] Connecting to %s", WIFI_SSID);
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  unsigned long startAttempt = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - startAttempt < 20000UL) {
    feedGps(250);
    Serial.print(".");
  }

  if (WiFi.status() == WL_CONNECTED) {
    Serial.printf("\n[WIFI] Connected! IP: %s | RSSI: %d dBm\n",
                  WiFi.localIP().toString().c_str(), WiFi.RSSI());
    blinkStatusLed(2, 80);
  } else {
    Serial.println("\n[WIFI] Connection timed out. Will retry next cycle.");
  }
}

String formatIsoTimestamp() {
  char tsBuffer[32];
  if (gps.date.isValid() && gps.time.isValid() && gps.date.year() >= 2024) {
    snprintf(
      tsBuffer,
      sizeof(tsBuffer),
      "%04d-%02d-%02dT%02d:%02d:%02dZ",
      gps.date.year(),
      gps.date.month(),
      gps.date.day(),
      gps.time.hour(),
      gps.time.minute(),
      gps.time.second()
    );
    return String(tsBuffer);
  }
  // Fallback empty string if GPS RTC not yet synced; backend defaults to server UTC
  return String("");
}

bool sendMultipartTelemetry(camera_fb_t* fb, double lat, double lon, const String& isoTimestamp) {
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("[HTTP] Skipping upload: WiFi disconnected.");
    return false;
  }

  const String boundary = "----CivicWatchESP32Boundary7MA4YWxkTrZu0gW";

  String partHeader;
  partHeader.reserve(512);

  // Field 1: device_id
  partHeader += "--" + boundary + "\r\n";
  partHeader += "Content-Disposition: form-data; name=\"device_id\"\r\n\r\n";
  partHeader += String(DEVICE_ID) + "\r\n";

  // Field 2: latitude
  partHeader += "--" + boundary + "\r\n";
  partHeader += "Content-Disposition: form-data; name=\"latitude\"\r\n\r\n";
  partHeader += String(lat, 6) + "\r\n";

  // Field 3: longitude
  partHeader += "--" + boundary + "\r\n";
  partHeader += "Content-Disposition: form-data; name=\"longitude\"\r\n\r\n";
  partHeader += String(lon, 6) + "\r\n";

  // Field 4: timestamp (only include if GPS RTC produced a valid timestamp)
  if (isoTimestamp.length() > 0) {
    partHeader += "--" + boundary + "\r\n";
    partHeader += "Content-Disposition: form-data; name=\"timestamp\"\r\n\r\n";
    partHeader += isoTimestamp + "\r\n";
  }

  // Field 5: image (JPEG binary)
  partHeader += "--" + boundary + "\r\n";
  partHeader += "Content-Disposition: form-data; name=\"image\"; filename=\"frame.jpg\"\r\n";
  partHeader += "Content-Type: image/jpeg\r\n\r\n";

  String partFooter = "\r\n--" + boundary + "--\r\n";

  size_t headerLen  = partHeader.length();
  size_t footerLen  = partFooter.length();
  size_t totalLen   = headerLen + fb->len + footerLen;

  // Allocate contiguous payload buffer in PSRAM (or heap fallback)
  uint8_t* payload = nullptr;
  if (psramFound()) {
    payload = (uint8_t*)ps_malloc(totalLen);
  }
  if (payload == nullptr) {
    payload = (uint8_t*)malloc(totalLen);
  }
  if (payload == nullptr) {
    Serial.printf("[HTTP] Memory allocation failed for %u bytes.\n", (unsigned int)totalLen);
    return false;
  }

  memcpy(payload, partHeader.c_str(), headerLen);
  memcpy(payload + headerLen, fb->buf, fb->len);
  memcpy(payload + headerLen + fb->len, partFooter.c_str(), footerLen);

  HTTPClient http;
  http.begin(INGEST_URL);
  http.setTimeout(15000);
  http.addHeader("Content-Type", "multipart/form-data; boundary=" + boundary);

  Serial.printf("[HTTP] Uploading %u bytes (lat=%.6f, lon=%.6f)...\n",
                (unsigned int)totalLen, lat, lon);

  int httpCode = http.POST(payload, totalLen);
  free(payload);

  if (httpCode > 0) {
    String responseBody = http.getString();
    Serial.printf("[HTTP] Response Code: %d\n", httpCode);
    Serial.printf("[HTTP] Payload: %s\n", responseBody.c_str());
    http.end();
    return (httpCode >= 200 && httpCode < 300);
  } else {
    Serial.printf("[HTTP] POST failed, error: %s\n", http.errorToString(httpCode).c_str());
    http.end();
    return false;
  }
}

void captureAndDispatchTelemetry() {
  double lat = FALLBACK_LAT;
  double lon = FALLBACK_LON;
  bool hasFix = gps.location.isValid() && gps.location.age() < 10000;

  if (hasFix) {
    lat = gps.location.lat();
    lon = gps.location.lng();
    Serial.printf("[GPS] Valid Fix | Lat: %.6f | Lon: %.6f | Sats: %lu\n",
                  lat, lon, gps.satellites.value());
  } else {
    Serial.printf("[GPS] No satellite lock yet (chars=%lu). ", gps.charsProcessed());
    if (REQUIRE_VALID_GPS_FIX) {
      Serial.println("Skipping capture until fix is acquired.");
      return;
    }
    Serial.printf("Using fallback coordinates (%.6f, %.6f).\n", lat, lon);
  }

  // Discard stale buffered frame before capturing fresh scene
  camera_fb_t* stale = esp_camera_fb_get();
  if (stale != nullptr) {
    esp_camera_fb_return(stale);
  }

  digitalWrite(STATUS_LED_PIN, LOW);
  camera_fb_t* fb = esp_camera_fb_get();
  digitalWrite(STATUS_LED_PIN, HIGH);

  if (fb == nullptr) {
    Serial.println("[CAM] Frame capture failed.");
    return;
  }

  Serial.printf("[CAM] Captured JPEG frame: %u bytes (%ux%u)\n",
                (unsigned int)fb->len, fb->width, fb->height);

  String isoTs = formatIsoTimestamp();
  bool ok = sendMultipartTelemetry(fb, lat, lon, isoTs);

  esp_camera_fb_return(fb);

  if (ok) {
    blinkStatusLed(1, 120);
  } else {
    blinkStatusLed(3, 60);
  }
}

// ---------------------------------------------------------------------------
// Arduino Setup & Main Loop
// ---------------------------------------------------------------------------

void setup() {
  // Disable brownout detector to prevent resets during Wi-Fi TX + Camera capture peaks
  WRITE_PERI_REG(RTC_CNTL_BROWN_OUT_REG, 0);

  Serial.begin(115200);
  Serial.setDebugOutput(false);
  Serial.println("\n=== CivicWatch ESP32-CAM + NEO-6M Telemetry Node ===");

  pinMode(STATUS_LED_PIN, OUTPUT);
  digitalWrite(STATUS_LED_PIN, HIGH);

  pinMode(FLASH_LED_PIN, OUTPUT);
  digitalWrite(FLASH_LED_PIN, LOW);

  GPSSerial.begin(GPS_BAUD_RATE, SERIAL_8N1, GPS_RX_PIN, GPS_TX_PIN);
  Serial.printf("[GPS] UART1 listening on RX=GPIO%d, TX=GPIO%d at %d baud\n",
                GPS_RX_PIN, GPS_TX_PIN, GPS_BAUD_RATE);

  if (!initCamera()) {
    Serial.println("[SYS] Fatal camera error. Rebooting in 5 seconds...");
    delay(5000);
    ESP.restart();
  }

  ensureWiFiConnected();
  lastTelemetryMillis = millis() - TELEMETRY_INTERVAL_MS;  // Trigger first capture promptly
}

void loop() {
  // Continuously parse incoming NMEA sentences from NEO-6M
  while (GPSSerial.available() > 0) {
    gps.encode(GPSSerial.read());
  }

  ensureWiFiConnected();

  unsigned long now = millis();
  if (now - lastTelemetryMillis >= TELEMETRY_INTERVAL_MS) {
    lastTelemetryMillis = now;
    captureAndDispatchTelemetry();
  }

  delay(20);
}
