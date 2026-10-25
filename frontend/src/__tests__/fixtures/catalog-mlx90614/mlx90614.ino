#include <Adafruit_MLX90614.h>

Adafruit_MLX90614 mlx = Adafruit_MLX90614();

void setup() {
  Serial.begin(115200);
  if (!mlx.begin()) {
    Serial.println("MLX90614 not found - check SDA/SCL");
    while (true) delay(10);
  }
}

void loop() {
  Serial.print("Ambient: ");
  Serial.print(mlx.readAmbientTempC());
  Serial.print(" C, object: ");
  Serial.print(mlx.readObjectTempC());
  Serial.println(" C");
  delay(500);
}
