#include <Wire.h>
#include "MAX30105.h"
#include "heartRate.h"

MAX30105 particleSensor;

const byte RATE_SIZE = 4;  // beats averaged
byte rates[RATE_SIZE];
byte rateSpot = 0;
long lastBeat = 0;
int beatAvg = 0;
unsigned long lastPrint = 0;

void setup() {
  Serial.begin(115200);
  if (!particleSensor.begin(Wire, I2C_SPEED_FAST)) {
    Serial.println("MAX30102 not found - check SDA/SCL");
    while (true) delay(10);
  }
  particleSensor.setup();                    // 400 Hz, 4x averaging: 100 samples/s
  particleSensor.setPulseAmplitudeRed(0x0A); // red LED low, IR does the work
}

void loop() {
  long ir = particleSensor.getIR();
  if (checkForBeat(ir)) {
    long delta = millis() - lastBeat;
    lastBeat = millis();
    float bpm = 60 / (delta / 1000.0);
    if (bpm > 20 && bpm < 255) {
      rates[rateSpot++] = (byte)bpm;
      rateSpot %= RATE_SIZE;
      beatAvg = 0;
      for (byte i = 0; i < RATE_SIZE; i++) beatAvg += rates[i];
      beatAvg /= RATE_SIZE;
    }
  }
  if (millis() - lastPrint >= 500) {
    lastPrint = millis();
    Serial.print("IR: ");
    Serial.print(ir);
    if (ir < 50000) {
      Serial.println("  (no finger)");
    } else {
      Serial.print("  BPM: ");
      Serial.println(beatAvg);
    }
  }
}
