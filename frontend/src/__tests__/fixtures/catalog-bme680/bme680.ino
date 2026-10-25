#include <Adafruit_BME680.h>

Adafruit_BME680 bme;

void setup() {
  Serial.begin(115200);
  if (!bme.begin()) {
    Serial.println("BME680 not found at 0x77 - check SDA/SCL");
    while (true) delay(10);
  }
  bme.setTemperatureOversampling(BME680_OS_8X);
  bme.setHumidityOversampling(BME680_OS_2X);
  bme.setPressureOversampling(BME680_OS_4X);
  bme.setGasHeater(320, 150);  // 320 C for 150 ms
}

void loop() {
  if (!bme.performReading()) {
    Serial.println("BME680 reading failed");
    return;
  }
  Serial.print("T: ");
  Serial.print(bme.temperature);
  Serial.print(" C, RH: ");
  Serial.print(bme.humidity);
  Serial.print(" %, P: ");
  Serial.print(bme.pressure / 100.0);
  Serial.print(" hPa, gas: ");
  Serial.print(bme.gas_resistance / 1000.0);
  Serial.println(" kOhm");
  delay(2000);
}
