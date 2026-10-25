#include <Adafruit_CCS811.h>

Adafruit_CCS811 ccs;

void setup() {
  Serial.begin(115200);
  if (!ccs.begin()) {
    Serial.println("CCS811 not found - check SDA/SCL and that WAK is on GND");
    while (true) delay(10);
  }
  while (!ccs.available()) delay(10);
}

void loop() {
  if (ccs.available() && !ccs.readData()) {
    Serial.print("eCO2: ");
    Serial.print(ccs.geteCO2());
    Serial.print(" ppm, TVOC: ");
    Serial.print(ccs.getTVOC());
    Serial.println(" ppb");
  }
  delay(1000);
}
