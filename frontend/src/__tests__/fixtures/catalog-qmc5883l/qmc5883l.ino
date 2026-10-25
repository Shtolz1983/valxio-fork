#include <QMC5883LCompass.h>

QMC5883LCompass compass;

void setup() {
  Serial.begin(115200);
  compass.init();
}

void loop() {
  compass.read();
  Serial.print("Azimuth: ");
  Serial.print(compass.getAzimuth());
  Serial.println(" deg");
  delay(250);
}
