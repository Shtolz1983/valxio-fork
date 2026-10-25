/**
 * Datasheet-level knowledge about boards and parts that the canvas metadata
 * does not carry: what each pin does from the microcontroller's point of
 * view, supply range, I2C addresses, which libraries drive the part, and the
 * board pins that carry restrictions (input-only, strapping, flash, ADC2…).
 *
 * Consumed by the logic-level circuit validator (./circuitValidator.ts) and
 * handed to the AI assistant through the get_pins tool, so the model wires
 * and codes from facts instead of memory. Pin names are the exact names the
 * rendered elements report in `pinInfo`.
 */

/**
 * Role of a part pin, seen from the board:
 *  - mcu-out:   the board drives it (LED anode, TRIG, servo PWM, DIN, CS…)
 *  - mcu-in:    the part drives it and the board reads it (PIR OUT, ECHO, DO)
 *  - analog-in: the part outputs an analog voltage the board reads with analogRead
 *  - bidir:     both drive it in turn (DHT data, 1-Wire)
 *  - i2c-sda / i2c-scl, spi-*: bus lines (shared between parts by design)
 *  - power / ground: supply pins
 *  - passive:   no direction of its own (button legs, LED cathode, buzzer pins)
 *  - nc:        not connected inside the part
 */
export type PinRole =
  | 'mcu-out'
  | 'mcu-in'
  | 'analog-in'
  | 'bidir'
  | 'i2c-sda'
  | 'i2c-scl'
  | 'spi-sck'
  | 'spi-mosi'
  | 'spi-miso'
  | 'spi-cs'
  | 'power'
  | 'ground'
  | 'passive'
  | 'nc';

export interface PartKnowledge {
  label: string;
  /** Supply range in volts (the module as sold, not the bare chip). */
  supply?: { min: number; max: number };
  pins: Record<string, PinRole>;
  /** Signal pins that must be wired for the part to work at all ("DO|MISO" = either name). */
  required?: string[];
  /** A switch: drives its line only while pressed (harmless on boot-strap pins). */
  momentary?: boolean;
  i2c?: {
    addresses: number[];
    /** Component property holding the configured address (e.g. "0x3c"). */
    addressProp?: string;
    /** Address strap pin: wired to a supply rail selects `high`, else addresses[0]. */
    addressPin?: { pin: string; high: number };
  };
  /** Arduino Library Manager names. */
  libraries?: string[];
  notes?: string[];
}

const SENSOR_DIGITAL_ANALOG = (label: string, notes?: string[]): PartKnowledge => ({
  label,
  supply: { min: 3.3, max: 5.5 },
  pins: { VCC: 'power', GND: 'ground', AOUT: 'analog-in', DOUT: 'mcu-in' },
  notes,
});

export const PART_KNOWLEDGE: Record<string, PartKnowledge> = {
  // ── Sensors ────────────────────────────────────────────────────────────
  dht22: {
    label: 'DHT22 temperature/humidity sensor',
    supply: { min: 3.3, max: 6 },
    pins: { VCC: 'power', SDA: 'bidir', NC: 'nc', GND: 'ground' },
    required: ['SDA'],
    libraries: ['DHT sensor library', 'Adafruit Unified Sensor'],
    notes: [
      'The SDA pin is the single-wire data line (not I2C): DHT dht(<gpio>, DHT22).',
      'Read at most every 2 s; readTemperature() returns NaN on a failed read.',
    ],
  },
  bmp280: {
    label: 'BMP280 pressure/temperature sensor (I2C)',
    supply: { min: 1.8, max: 3.6 },
    pins: { SDA: 'i2c-sda', SCL: 'i2c-scl', GND: 'ground', VCC: 'power' },
    required: ['SDA', 'SCL'],
    i2c: { addresses: [0x76, 0x77] },
    libraries: ['Adafruit BMP280 Library'],
    notes: ['Power from 3.3 V. bmp.begin(0x76) — the simulated part answers at 0x76.'],
  },
  mpu6050: {
    label: 'MPU6050 accelerometer/gyroscope (I2C)',
    supply: { min: 3, max: 5.5 },
    pins: {
      INT: 'mcu-in',
      AD0: 'passive',
      XCL: 'nc',
      XDA: 'nc',
      SDA: 'i2c-sda',
      SCL: 'i2c-scl',
      GND: 'ground',
      VCC: 'power',
    },
    required: ['SDA', 'SCL'],
    i2c: { addresses: [0x68, 0x69], addressPin: { pin: 'AD0', high: 0x69 } },
    libraries: ['Adafruit MPU6050', 'Adafruit Unified Sensor'],
    notes: ['AD0 to GND or open = 0x68, AD0 to VCC = 0x69 (lets two MPU6050 share a bus).'],
  },
  'hc-sr04': {
    label: 'HC-SR04 ultrasonic distance sensor',
    supply: { min: 4.5, max: 5.5 },
    pins: { VCC: 'power', TRIG: 'mcu-out', ECHO: 'mcu-in', GND: 'ground' },
    required: ['TRIG', 'ECHO'],
    notes: [
      'Needs 5 V. ECHO outputs 5 V: on a 3.3 V board (ESP32, Pico) put a divider (e.g. 1k/2k) on ECHO.',
      'Pulse TRIG high for 10 µs, then pulseIn(ECHO, HIGH); distance_cm = duration / 58.',
    ],
  },
  'pir-motion-sensor': {
    label: 'PIR motion sensor',
    supply: { min: 4.5, max: 20 },
    pins: { VCC: 'power', OUT: 'mcu-in', GND: 'ground' },
    required: ['OUT'],
    notes: ['OUT is 3.3 V logic on HC-SR501 modules, safe for 3.3 V boards.'],
  },
  'photoresistor-sensor': {
    label: 'Photoresistor (LDR) module',
    supply: { min: 3.3, max: 5.5 },
    pins: { VCC: 'power', GND: 'ground', DO: 'mcu-in', AO: 'analog-in' },
    notes: ['AO gives an analog level (analogRead), DO a thresholded digital level.'],
  },
  'ntc-temperature-sensor': {
    label: 'NTC thermistor module',
    supply: { min: 3.3, max: 5.5 },
    pins: { GND: 'ground', VCC: 'power', OUT: 'analog-in' },
    required: ['OUT'],
  },
  'gas-sensor': SENSOR_DIGITAL_ANALOG('MQ gas sensor module', ['The heater needs 5 V.']),
  'flame-sensor': SENSOR_DIGITAL_ANALOG('Flame sensor module'),
  'small-sound-sensor': SENSOR_DIGITAL_ANALOG('Sound sensor module'),
  'big-sound-sensor': SENSOR_DIGITAL_ANALOG('Sound sensor module'),
  'heart-beat-sensor': {
    label: 'Pulse sensor',
    supply: { min: 3, max: 5.5 },
    pins: { GND: 'ground', VCC: 'power', OUT: 'analog-in' },
    required: ['OUT'],
  },
  'tilt-switch': {
    label: 'Tilt switch module',
    supply: { min: 3.3, max: 5.5 },
    pins: { GND: 'ground', VCC: 'power', OUT: 'mcu-in' },
    required: ['OUT'],
  },
  'gps-neo6m': {
    label: 'NEO-6M GPS module (UART)',
    supply: { min: 3.3, max: 5 },
    pins: { VCC: 'power', RX: 'mcu-out', TX: 'mcu-in', GND: 'ground' },
    required: ['TX'],
    libraries: ['TinyGPSPlus'],
    notes: ['Cross the lines: GPS TX → board RX pin, GPS RX → board TX pin. 9600 baud.'],
  },
  'ir-receiver': {
    label: 'IR receiver',
    supply: { min: 2.7, max: 5.5 },
    pins: { GND: 'ground', VCC: 'power', DAT: 'mcu-in' },
    required: ['DAT'],
    libraries: ['IRremote'],
  },
  hx711: {
    label: 'HX711 load-cell amplifier',
    supply: { min: 2.6, max: 5.5 },
    pins: { VCC: 'power', DT: 'mcu-in', SCK: 'mcu-out', GND: 'ground' },
    required: ['DT', 'SCK'],
    libraries: ['HX711 Arduino Library'],
  },
  ds1307: {
    label: 'DS1307 real-time clock (I2C)',
    supply: { min: 4.5, max: 5.5 },
    pins: { GND: 'ground', '5V': 'power', SDA: 'i2c-sda', SCL: 'i2c-scl', SQW: 'mcu-in' },
    required: ['SDA', 'SCL'],
    i2c: { addresses: [0x68] },
    libraries: ['RTClib'],
  },
  ds3231: {
    label: 'DS3231 real-time clock (I2C)',
    supply: { min: 2.3, max: 5.5 },
    pins: { GND: 'ground', VCC: 'power', SDA: 'i2c-sda', SCL: 'i2c-scl' },
    required: ['SDA', 'SCL'],
    i2c: { addresses: [0x68] },
    libraries: ['RTClib'],
  },

  // ── Displays ───────────────────────────────────────────────────────────
  'ssd1306-i2c-4pin': {
    label: 'SSD1306 OLED 128×64 (I2C, 4 pins)',
    supply: { min: 3, max: 5.5 },
    pins: { GND: 'ground', VCC: 'power', SCL: 'i2c-scl', SDA: 'i2c-sda' },
    required: ['SDA', 'SCL'],
    i2c: { addresses: [0x3c, 0x3d], addressProp: 'i2cAddress' },
    libraries: ['Adafruit GFX Library', 'Adafruit SSD1306'],
    notes: ['Adafruit_SSD1306 display(128, 64, &Wire, -1); display.begin(SSD1306_SWITCHCAPVCC, 0x3C).'],
  },
  ssd1306: {
    label: 'SSD1306 OLED 128×64 (7 pins, I2C or SPI)',
    supply: { min: 3, max: 5.5 },
    pins: {
      DATA: 'i2c-sda',
      CLK: 'i2c-scl',
      DC: 'mcu-out',
      RST: 'mcu-out',
      CS: 'spi-cs',
      '3V3': 'power',
      VIN: 'power',
      GND: 'ground',
    },
    required: ['DATA', 'CLK'],
    i2c: { addresses: [0x3c, 0x3d], addressProp: 'i2cAddress' },
    libraries: ['Adafruit GFX Library', 'Adafruit SSD1306'],
    notes: ['In I2C mode DATA = SDA and CLK = SCL; prefer the 4-pin ssd1306-i2c-4pin for I2C.'],
  },
  'lcd1602-i2c': {
    label: 'LCD 16×2 with I2C backpack',
    supply: { min: 4.5, max: 5.5 },
    pins: { GND: 'ground', VCC: 'power', SDA: 'i2c-sda', SCL: 'i2c-scl' },
    required: ['SDA', 'SCL'],
    i2c: { addresses: [0x27, 0x3f], addressProp: 'i2cAddress' },
    libraries: ['LiquidCrystal I2C'],
    notes: ['LiquidCrystal_I2C lcd(0x27, 16, 2); lcd.init(); lcd.backlight();'],
  },
  'lcd2004-i2c': {
    label: 'LCD 20×4 with I2C backpack',
    supply: { min: 4.5, max: 5.5 },
    pins: { GND: 'ground', VCC: 'power', SDA: 'i2c-sda', SCL: 'i2c-scl' },
    required: ['SDA', 'SCL'],
    i2c: { addresses: [0x27, 0x3f], addressProp: 'i2cAddress' },
    libraries: ['LiquidCrystal I2C'],
  },
  ili9341: {
    label: 'ILI9341 2.8" TFT (SPI)',
    supply: { min: 3.3, max: 5 },
    pins: {
      VCC: 'power',
      GND: 'ground',
      CS: 'spi-cs',
      RST: 'mcu-out',
      'D/C': 'mcu-out',
      MOSI: 'spi-mosi',
      SCK: 'spi-sck',
      LED: 'power',
      MISO: 'spi-miso',
    },
    required: ['CS', 'D/C', 'MOSI', 'SCK'],
    libraries: ['Adafruit GFX Library', 'Adafruit ILI9341'],
  },

  // ── Outputs and actuators ──────────────────────────────────────────────
  led: {
    label: 'LED',
    pins: { A: 'mcu-out', C: 'passive' },
    notes: ['Anode (A) to the GPIO through a 220–330 Ω resistor, cathode (C) to GND.'],
  },
  'rgb-led': {
    label: 'RGB LED (common cathode)',
    pins: { R: 'mcu-out', G: 'mcu-out', B: 'mcu-out', COM: 'passive' },
    notes: ['One resistor per colour channel; COM to GND.'],
  },
  buzzer: {
    label: 'Piezo buzzer',
    pins: { '1': 'passive', '2': 'passive' },
    notes: ['One pin to a GPIO, the other to GND; tone(pin, freq).'],
  },
  servo: {
    label: 'Hobby servo',
    supply: { min: 4.5, max: 6 },
    pins: { GND: 'ground', 'V+': 'power', PWM: 'mcu-out' },
    required: ['PWM'],
    libraries: ['Servo'],
    notes: ['On ESP32 use the "ESP32Servo" library instead of "Servo".', 'Power V+ from 5 V, not from 3.3 V.'],
  },
  neopixel: {
    label: 'WS2812 NeoPixel',
    supply: { min: 3.5, max: 5.5 },
    pins: { VDD: 'power', DOUT: 'nc', VSS: 'ground', DIN: 'mcu-out' },
    required: ['DIN'],
    libraries: ['Adafruit NeoPixel'],
  },
  'led-ring': {
    label: 'WS2812 LED ring',
    supply: { min: 3.5, max: 5.5 },
    pins: { GND: 'ground', VCC: 'power', DIN: 'mcu-out', DOUT: 'nc' },
    required: ['DIN'],
    libraries: ['Adafruit NeoPixel'],
  },
  'neopixel-matrix': {
    label: 'WS2812 LED matrix',
    supply: { min: 3.5, max: 5.5 },
    pins: { GND: 'ground', VCC: 'power', DIN: 'mcu-out', DOUT: 'nc' },
    required: ['DIN'],
    libraries: ['Adafruit NeoPixel'],
  },
  relay: {
    label: 'Relay',
    pins: { 'COIL+': 'mcu-out', 'COIL-': 'passive', NO: 'passive', COM: 'passive', NC: 'passive' },
    notes: ['A bare relay coil draws ~70 mA — drive it through a transistor, not straight from a GPIO.'],
  },

  // ── Inputs ─────────────────────────────────────────────────────────────
  pushbutton: {
    label: 'Push button',
    pins: { '1.l': 'mcu-in', '2.l': 'mcu-in', '1.r': 'mcu-in', '2.r': 'mcu-in' },
    momentary: true,
    notes: [
      'Wire one side to a GPIO and the other to GND, then pinMode(pin, INPUT_PULLUP): pressed reads LOW.',
      'Pins 1.l/1.r are the same contact, as are 2.l/2.r — use a 1.x pin and a 2.x pin.',
    ],
  },
  potentiometer: {
    label: 'Potentiometer',
    pins: { GND: 'ground', SIG: 'analog-in', VCC: 'power' },
    required: ['SIG'],
  },
  'slide-potentiometer': {
    label: 'Slide potentiometer',
    pins: { VCC: 'power', SIG: 'analog-in', GND: 'ground' },
    required: ['SIG'],
  },
  'ky-040': {
    label: 'KY-040 rotary encoder',
    supply: { min: 3.3, max: 5.5 },
    pins: { CLK: 'mcu-in', DT: 'mcu-in', SW: 'mcu-in', VCC: 'power', GND: 'ground' },
    required: ['CLK', 'DT'],
  },
  'analog-joystick': {
    label: 'Analog joystick',
    supply: { min: 3.3, max: 5.5 },
    pins: { VCC: 'power', VERT: 'analog-in', HORZ: 'analog-in', SEL: 'mcu-in', GND: 'ground' },
    notes: ['Wire the axes you read: VERT and HORZ are analog outputs, SEL is the push switch (INPUT_PULLUP).'],
  },

  // ── Storage ────────────────────────────────────────────────────────────
  'microsd-card': {
    label: 'microSD card module (SPI)',
    supply: { min: 3.3, max: 5 },
    // The element reports DO/DI; wires may also use the MISO/MOSI aliases.
    pins: {
      CD: 'mcu-in',
      DO: 'spi-miso',
      MISO: 'spi-miso',
      GND: 'ground',
      SCK: 'spi-sck',
      VCC: 'power',
      DI: 'spi-mosi',
      MOSI: 'spi-mosi',
      CS: 'spi-cs',
    },
    required: ['DO|MISO', 'SCK', 'DI|MOSI', 'CS'],
    libraries: ['SD'],
  },
};

// ── Boards ───────────────────────────────────────────────────────────────

export interface BoardKnowledge {
  label: string;
  /** I/O voltage. */
  logicVolts: 3.3 | 5;
  /** Whether GPIOs accept 5 V inputs. */
  fiveVoltTolerant: boolean;
  /** GPIO numbers (as boardPinToNumber returns them). */
  inputOnly: number[];
  strapping: number[];
  /** Strapping pins whose normal-boot level is HIGH — a pulled-up line there is fine. */
  strappingHighOk: number[];
  flash: number[];
  /** GPIOs shared with the USB serial port (Serial). */
  serial: number[];
  /** GPIOs with an ADC. */
  analog: number[];
  /** ADC2 channels — unusable while Wi-Fi runs (ESP32 family). */
  adc2: number[];
  i2c: { sda: number; scl: number; anyPins: boolean };
  spi?: { sck: number; miso: number; mosi: number; cs: number };
  notes: string[];
}

const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);

const ESP32: BoardKnowledge = {
  label: 'ESP32',
  logicVolts: 3.3,
  fiveVoltTolerant: false,
  inputOnly: [34, 35, 36, 39],
  // GPIO0/2 select the boot mode and GPIO12 the flash voltage — a part holding
  // them at reset stops the boot. GPIO5/15 only change SDIO timing / boot log.
  strapping: [0, 2, 12],
  strappingHighOk: [0],
  flash: range(6, 11),
  serial: [1, 3],
  analog: [0, 2, 4, 12, 13, 14, 15, 25, 26, 27, 32, 33, 34, 35, 36, 39],
  adc2: [0, 2, 4, 12, 13, 14, 15, 25, 26, 27],
  i2c: { sda: 21, scl: 22, anyPins: true },
  spi: { sck: 18, miso: 19, mosi: 23, cs: 5 },
  notes: [
    '3.3 V logic, GPIOs are not 5 V tolerant.',
    'GPIO34–39 (34, 35, VP=36, VN=39) are input-only and have no pull-ups.',
    'Default I2C SDA=21, SCL=22; Wire.begin(sda, scl) moves it to any pins.',
    'Use ADC1 pins (32–39) for analogRead when Wi-Fi is on.',
  ],
};

const ESP32_S3: BoardKnowledge = {
  label: 'ESP32-S3',
  logicVolts: 3.3,
  fiveVoltTolerant: false,
  inputOnly: [],
  strapping: [0, 3, 45, 46],
  strappingHighOk: [0, 3],
  flash: range(26, 32),
  serial: [43, 44],
  analog: range(1, 20),
  adc2: range(11, 20),
  i2c: { sda: 8, scl: 9, anyPins: true },
  spi: { sck: 12, miso: 13, mosi: 11, cs: 10 },
  notes: ['3.3 V logic, GPIOs are not 5 V tolerant.', 'Default I2C SDA=8, SCL=9.'],
};

const ESP32_C3: BoardKnowledge = {
  label: 'ESP32-C3',
  logicVolts: 3.3,
  fiveVoltTolerant: false,
  inputOnly: [],
  strapping: [2, 8, 9],
  strappingHighOk: [2, 8, 9],
  flash: range(12, 17),
  serial: [20, 21],
  analog: range(0, 5),
  adc2: [5],
  i2c: { sda: 8, scl: 9, anyPins: true },
  spi: { sck: 4, miso: 5, mosi: 6, cs: 7 },
  notes: ['3.3 V logic, GPIOs are not 5 V tolerant.', 'Default I2C SDA=8, SCL=9.'],
};

const AVR_UNO: BoardKnowledge = {
  label: 'Arduino Uno',
  logicVolts: 5,
  fiveVoltTolerant: true,
  inputOnly: [],
  strapping: [],
  strappingHighOk: [],
  flash: [],
  serial: [0, 1],
  analog: range(14, 19),
  adc2: [],
  i2c: { sda: 18, scl: 19, anyPins: false },
  spi: { sck: 13, miso: 12, mosi: 11, cs: 10 },
  notes: ['5 V logic.', 'I2C only on A4 (SDA) / A5 (SCL).', 'PWM (analogWrite) on 3, 5, 6, 9, 10, 11.'],
};

const AVR_NANO: BoardKnowledge = {
  ...AVR_UNO,
  label: 'Arduino Nano',
  inputOnly: [20, 21],
  analog: range(14, 21),
  notes: [...AVR_UNO.notes, 'A6 and A7 are analog-input-only.'],
};

const AVR_MEGA: BoardKnowledge = {
  label: 'Arduino Mega 2560',
  logicVolts: 5,
  fiveVoltTolerant: true,
  inputOnly: [],
  strapping: [],
  strappingHighOk: [],
  flash: [],
  serial: [0, 1],
  analog: range(54, 69),
  adc2: [],
  i2c: { sda: 20, scl: 21, anyPins: false },
  spi: { sck: 52, miso: 50, mosi: 51, cs: 53 },
  notes: ['5 V logic.', 'I2C only on 20 (SDA) / 21 (SCL).', 'Extra hardware serial ports on 14–19.'],
};

const RP2040: BoardKnowledge = {
  label: 'Raspberry Pi Pico',
  logicVolts: 3.3,
  fiveVoltTolerant: false,
  inputOnly: [],
  strapping: [],
  strappingHighOk: [],
  flash: [],
  serial: [],
  analog: [26, 27, 28],
  adc2: [],
  i2c: { sda: 4, scl: 5, anyPins: true },
  spi: { sck: 18, miso: 16, mosi: 19, cs: 17 },
  notes: ['3.3 V logic, GPIOs are not 5 V tolerant.', 'Default I2C SDA=GP4, SCL=GP5.', 'ADC on GP26–28 (A0–A2).'],
};

const BOARD_FAMILY: Record<string, BoardKnowledge> = {
  esp32: ESP32,
  'esp32-devkit-c-v4': ESP32,
  'esp32-cam': ESP32,
  'wemos-lolin32-lite': ESP32,
  'esp32-s3': ESP32_S3,
  'xiao-esp32-s3': ESP32_S3,
  'arduino-nano-esp32': ESP32_S3,
  'esp32-c3': ESP32_C3,
  'xiao-esp32-c3': ESP32_C3,
  'aitewinrobot-esp32c3-supermini': ESP32_C3,
  'arduino-uno': AVR_UNO,
  'arduino-nano': AVR_NANO,
  'arduino-mega': AVR_MEGA,
  'raspberry-pi-pico': RP2040,
  'pi-pico-w': RP2040,
};

export function boardKnowledge(boardKind: string): BoardKnowledge | undefined {
  return BOARD_FAMILY[boardKind];
}

/**
 * Add knowledge for a part the parts catalogue brings (parts-catalog/*.json).
 * The hand-written entries above stay authoritative for their ids.
 */
export function registerPartKnowledge(metadataId: string, knowledge: PartKnowledge): void {
  if (!PART_KNOWLEDGE[metadataId]) PART_KNOWLEDGE[metadataId] = knowledge;
}

export function partKnowledge(metadataId: string): PartKnowledge | undefined {
  return PART_KNOWLEDGE[metadataId] ?? PART_KNOWLEDGE[metadataId.replace(/^(wokwi|velxio)-/, '')];
}

/** Parse "0x3c" / "60" / 60 into a number, or undefined. */
export function parseI2cAddress(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v !== 'string' || !v.trim()) return undefined;
  const n = v.trim().toLowerCase().startsWith('0x') ? parseInt(v, 16) : parseInt(v, 10);
  return Number.isFinite(n) ? n : undefined;
}
