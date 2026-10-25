#include <MD_MAX72xx.h>

// FC16_HW suits most modules; try GENERIC_HW if the image is rotated or mirrored.
#define HARDWARE_TYPE MD_MAX72XX::FC16_HW
const int DIN_PIN = 2;
const int CLK_PIN = 3;
const int CS_PIN = 10;
const int MODULES = 1;  // chained 8x8 modules

MD_MAX72XX mx = MD_MAX72XX(HARDWARE_TYPE, DIN_PIN, CLK_PIN, CS_PIN, MODULES);

void setup() {
  mx.begin();
  mx.control(MD_MAX72XX::INTENSITY, 4);  // brightness 0..15
  mx.clear();
}

void loop() {
  for (uint8_t row = 0; row < 8; row++) {
    mx.setRow(row, 0xFF);
    delay(100);
  }
  mx.clear();
  delay(300);
}
