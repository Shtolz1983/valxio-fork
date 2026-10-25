#include <DHT.h>

DHT dht(2, DHT11);

void setup() {
  Serial.begin(115200);
  dht.begin();
}

void loop() {
  delay(2000);  // the DHT11 measures at most once per second
  float h = dht.readHumidity();
  float t = dht.readTemperature();
  if (isnan(h) || isnan(t)) {
    Serial.println("DHT11 read failed");
    return;
  }
  Serial.print("Temperature: ");
  Serial.print(t);
  Serial.print(" C, humidity: ");
  Serial.print(h);
  Serial.println(" %");
}
