#include <Adafruit_BMP085.h>

Adafruit_BMP085 bmp;

void setup() {
  Serial.begin(115200);
  if (!bmp.begin()) {
    Serial.println("BMP180 not found - check SDA/SCL");
    while (true) delay(10);
  }
}

void loop() {
  Serial.print("Temperature: ");
  Serial.print(bmp.readTemperature());
  Serial.print(" C, pressure: ");
  Serial.print(bmp.readPressure() / 100.0);
  Serial.println(" hPa");
  delay(1000);
}
