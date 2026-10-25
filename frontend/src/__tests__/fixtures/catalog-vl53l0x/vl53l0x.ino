#include <Wire.h>
#include <VL53L0X.h>

VL53L0X sensor;

void setup() {
  Serial.begin(115200);
  Wire.begin();
  sensor.setTimeout(500);
  if (!sensor.init()) {
    Serial.println("VL53L0X not found - check SDA/SCL");
    while (true) delay(10);
  }
  sensor.startContinuous();
}

void loop() {
  uint16_t mm = sensor.readRangeContinuousMillimeters();
  if (sensor.timeoutOccurred()) {
    Serial.println("timeout");
  } else {
    Serial.print("Distance: ");
    Serial.print(mm);
    Serial.println(" mm");
  }
  delay(100);
}
