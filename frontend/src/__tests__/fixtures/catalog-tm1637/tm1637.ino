#include <TM1637Display.h>

TM1637Display display(2, 3);
int counter = 0;

void setup() {
  display.setBrightness(5);  // 0..7
}

void loop() {
  display.showNumberDec(counter++);
  delay(1000);
}
