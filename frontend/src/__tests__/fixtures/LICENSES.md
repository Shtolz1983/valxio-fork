# Test firmware licenses (`catalog-*`)

Each `catalog-<part>/<part>.ino.hex` is the sketch next to it compiled for
the Arduino Uno (`arduino:avr` 1.8.8). The firmware therefore contains the
Arduino AVR core (including `Wire` and `SPI`) and the libraries the sketch
includes, at the versions below, all from the Arduino Library Manager. To
rebuild a file, install those versions and compile the `.ino` with
`arduino-cli compile --fqbn arduino:avr:uno --output-dir . <folder>`.

| Firmware | Library | Version | License |
| --- | --- | --- | --- |
| all | Arduino AVR core (`arduino:avr`) | 1.8.8 | LGPL-2.1 |
| adxl345, bme280, bme680, bmp180, ccs811, ina219, max31865, mlx90614 | Adafruit BusIO | 1.17.4 | MIT |
| adxl345, bme280, bme680 | Adafruit Unified Sensor | 1.1.15 | Apache-2.0 |
| adxl345 | Adafruit ADXL345 | 1.3.4 | BSD |
| bme280 | Adafruit BME280 Library | 2.3.0 | BSD |
| bme680 | Adafruit BME680 Library | 2.0.6 | BSD |
| bmp180 | Adafruit BMP085 Library | 1.2.4 | BSD |
| ccs811 | Adafruit CCS811 Library | 1.1.3 | MIT |
| dht11 | DHT sensor library | 1.4.7 | MIT |
| ds18b20 | OneWire | 2.3.8 | MIT-style (see `OneWire.h`) |
| ds18b20 | DallasTemperature | 4.0.6 | MIT |
| ina219 | Adafruit INA219 | 1.2.3 | BSD |
| max31865 | Adafruit MAX31865 library | 1.6.2 | BSD |
| max6675 | MAX6675 library | 1.1.2 | BSD |
| max7219-matrix | MD_MAX72XX | 3.5.1 | LGPL-2.1 |
| mlx90614 | Adafruit MLX90614 Library | 2.1.7 | BSD |
| qmc5883l | QMC5883LCompass | 1.2.3 | GPL-3.0 |
| rc522 | MFRC522 | 1.4.12 | Unlicense |
| tm1637 | TM1637 | 1.2.0 | LGPL-3.0 |
| vl53l0x | VL53L0X (Pololu) | 1.3.1 | MIT-style |

`max30102` uses only the core. The GPL-3.0 and LGPL firmware is
distributed with its complete source: the sketch here plus the libraries at
the versions listed, which are public. GPL-3.0 is compatible with this
repository's AGPL-3.0.
