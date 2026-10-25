// The TM1637 model's other paths: colon, display off, raw segments.
#include <TM1637Display.h>

TM1637Display display(2, 3);

void setup() {
  display.setBrightness(7);
  display.showNumberDecEx(1234, 0b01000000, true);  // 12:34
  delay(200);
  display.setBrightness(2, false);
  display.showNumberDec(-5, false);  // "  -5", display off
  delay(200);
  const uint8_t helo[] = {0x76, 0x79, 0x38, 0x3f};
  display.setBrightness(3, true);
  display.setSegments(helo);
}

void loop() {}
