// Orientation of the MAX7219 model: single pixels set through MD_MAX72XX.
#include <MD_MAX72xx.h>

MD_MAX72XX mx = MD_MAX72XX(MD_MAX72XX::FC16_HW, 2, 3, 10, 1);

void setup() {
  mx.begin();
  mx.setPoint(0, 0, true);  // row 0, column 0
  mx.setPoint(2, 5, true);
  mx.setPoint(7, 7, true);
  delay(100);
  mx.control(MD_MAX72XX::SHUTDOWN, MD_MAX72XX::ON);
  delay(100);
  mx.control(MD_MAX72XX::SHUTDOWN, MD_MAX72XX::OFF);
  mx.control(MD_MAX72XX::SCANLIMIT, 3);
}

void loop() {}
