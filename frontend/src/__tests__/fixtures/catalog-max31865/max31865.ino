#include <Adafruit_MAX31865.h>

const int CS_PIN = 10;
Adafruit_MAX31865 thermo = Adafruit_MAX31865(CS_PIN);

// 430.0 for PT100, 4300.0 for PT1000
#define RREF 430.0
// 100.0 for PT100, 1000.0 for PT1000
#define RNOMINAL 100.0

void setup() {
  Serial.begin(115200);
  thermo.begin(MAX31865_4WIRE);  // MAX31865_2WIRE or MAX31865_3WIRE to match the probe
}

void loop() {
  float t = thermo.temperature(RNOMINAL, RREF);
  uint8_t fault = thermo.readFault();
  if (fault) {
    Serial.print("Fault 0x");
    Serial.println(fault, HEX);
    thermo.clearFault();
  } else {
    Serial.print("Temperature: ");
    Serial.print(t);
    Serial.println(" C");
  }
  delay(1000);
}
