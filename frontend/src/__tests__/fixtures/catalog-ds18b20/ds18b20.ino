#include <OneWire.h>
#include <DallasTemperature.h>

const int ONE_WIRE_PIN = 2;
OneWire oneWire(ONE_WIRE_PIN);
DallasTemperature sensors(&oneWire);

void setup() {
  Serial.begin(115200);
  sensors.begin();
}

void loop() {
  sensors.requestTemperatures();
  float t = sensors.getTempCByIndex(0);
  if (t == DEVICE_DISCONNECTED_C) {
    Serial.println("DS18B20 not found - check the wiring and the 4.7k pull-up");
  } else {
    Serial.print("Temperature: ");
    Serial.print(t);
    Serial.println(" C");
  }
  delay(1000);
}
