#include <Adafruit_BME280.h>

Adafruit_BME280 bme;

void setup() {
  Serial.begin(115200);
  if (!bme.begin(0x76)) {
    Serial.println("BME280 not found at 0x76 - try 0x77, check SDA/SCL");
    while (true) delay(10);
  }
}

void loop() {
  Serial.print("Temperature: ");
  Serial.print(bme.readTemperature());
  Serial.print(" C, humidity: ");
  Serial.print(bme.readHumidity());
  Serial.print(" %, pressure: ");
  Serial.print(bme.readPressure() / 100.0F);
  Serial.println(" hPa");
  delay(1000);
}
