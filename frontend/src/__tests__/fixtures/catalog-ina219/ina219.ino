#include <Adafruit_INA219.h>

Adafruit_INA219 ina219;

void setup() {
  Serial.begin(115200);
  if (!ina219.begin()) {
    Serial.println("INA219 not found - check SDA/SCL");
    while (true) delay(10);
  }
}

void loop() {
  Serial.print("Bus: ");
  Serial.print(ina219.getBusVoltage_V());
  Serial.print(" V, current: ");
  Serial.print(ina219.getCurrent_mA());
  Serial.print(" mA, power: ");
  Serial.print(ina219.getPower_mW());
  Serial.println(" mW");
  delay(1000);
}
