#include <max6675.h>

const int THERMO_SCK = 2;
const int THERMO_CS = 10;
const int THERMO_SO = 3;
MAX6675 thermocouple(THERMO_SCK, THERMO_CS, THERMO_SO);

void setup() {
  Serial.begin(115200);
  delay(500);  // let the MAX6675 settle
}

void loop() {
  Serial.print("Thermocouple: ");
  Serial.print(thermocouple.readCelsius());
  Serial.println(" C");
  delay(1000);  // one conversion takes up to 220 ms
}
