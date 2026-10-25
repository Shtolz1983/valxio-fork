#include <Adafruit_ADXL345_U.h>

Adafruit_ADXL345_Unified accel = Adafruit_ADXL345_Unified(12345);

void setup() {
  Serial.begin(115200);
  if (!accel.begin()) {
    Serial.println("ADXL345 not found - check SDA/SCL");
    while (true) delay(10);
  }
  accel.setRange(ADXL345_RANGE_16_G);
}

void loop() {
  sensors_event_t event;
  accel.getEvent(&event);
  Serial.print("X: ");
  Serial.print(event.acceleration.x);
  Serial.print("  Y: ");
  Serial.print(event.acceleration.y);
  Serial.print("  Z: ");
  Serial.print(event.acceleration.z);
  Serial.println(" m/s^2");
  delay(200);
}
