# Parts catalogue

One JSON card per sensor or module. The editor loads every card at startup:

- the **Sensors** catalogue lists it (with "Place on canvas", "Insert example", "Ask AI");
- a card without `component` gets a generic module on the canvas, drawn from its `pins`;
- the circuit validator and the AI assistant (`get_pins`) read its pin roles, supply, I2C
  addresses, libraries and notes.

Cards the AI assistant writes ("+ Add sensor") arrive with `"status": "draft"` and are
checked first (schema, libraries install, the example compiles for Uno and ESP32).
Confirming a draft in the catalogue sets `"status": "verified"`.

Check every card (needs the Velxio backend on :3080):

```bash
cd ai-bridge && npm run verify-cards            # all cards
cd ai-bridge && npm run verify-cards -- ds18b20  # one card
```

## Format

```jsonc
{
  "id": "ds18b20",                  // = file name, a-z 0-9 -
  "name": "DS18B20",                // short name, drawn on the module
  "title": "Digital temperature sensor, 1-Wire, -55…125 °C",
  "titleRu": "Цифровой датчик температуры, 1-Wire, -55…125 °C",
  "group": "climate",               // see groups below
  "interface": "1-wire",            // i2c | spi | 1-wire | single-wire | analog | digital | uart
  "component": "dht22",             // optional: an existing canvas part to use instead of the generic module
  "pins": [                         // module header, left to right (required without "component")
    { "name": "GND", "role": "ground" },
    { "name": "DQ", "role": "bidir", "desc": "1-Wire data" },
    { "name": "VCC", "role": "power" }
  ],
  "supply": { "min": 3.0, "max": 5.5 },        // volts, the module as sold
  "i2c": { "addresses": ["0x76", "0x77"] },    // first = default
  "pullups": [{ "pin": "DQ", "ohms": 4700 }],  // external resistors to the module's supply
  "libraries": ["OneWire", "DallasTemperature"], // Arduino Library Manager names
  "example": "#include <OneWire.h>\n…",          // Arduino sketch; {{DQ}} = the board pin wired to DQ
  "notes": ["…"],
  "source": { "datasheet": "https://…", "library": "https://…" },
  "status": "verified",             // verified | draft
  "color": "#1d5b8f",               // optional PCB colour of the generic module
  "sim": { … }                      // optional: what the generic module does in the simulator
}
```

Pin roles (seen from the board): `mcu-out` (board drives it), `mcu-in` (module drives it),
`analog-in` (analog voltage the board reads), `bidir`, `i2c-sda`, `i2c-scl`, `spi-sck`,
`spi-mosi`, `spi-miso`, `spi-cs`, `power`, `ground`, `passive`, `nc`.

Placeholders: `{{PIN}}` in `example` is any signal pin of the card (not bus or power pins).
The catalogue fills it with the pin it wired (`4`, `A0`, …); the compile check uses a
free default pin of the board.

## Simulator values (`sim`)

Without `sim` a generic module is wired and compiles but stays silent in the
simulator. With it, clicking the module while the simulation runs opens a
sensor panel with sliders, and the module answers from their values:

```jsonc
"sim": {
  "controls": [                     // sliders; the value is stored in the component property `key`
    { "key": "rain", "label": "Rain", "min": 0, "max": 100, "step": 1, "unit": "%", "default": 0 }
  ],
  "outputs": [
    // analog-in pin: piecewise-linear volts ("volts") or fraction of the board's ADC rail ("ratio")
    { "pin": "AO", "kind": "analog", "from": "rain", "ratio": [[0, 0.98], [100, 0.2]] },
    // mcu-in pin: active while the value is above `above` (or below `below`;
    // a 0/1 switch without either is active at 1); activeLow = active drives LOW
    { "pin": "DO", "kind": "digital", "from": "rain", "above": 50, "activeLow": true }
  ],
  "model": "sht31"                  // the chip behind the module, see the table below
}
```

Models (`frontend/src/partsCatalog/models/`) and the control keys each reads
(the same list is `SIM_MODELS` in `ai-bridge/partCards.mjs`):

| Model | Bus | Control keys |
|---|---|---|
| `bh1750` | I2C | `lux` |
| `aht20`, `sht31`, `dht11` | I2C / data line | `temperature`, `humidity` |
| `adxl345` | I2C | `accelX`, `accelY`, `accelZ` (g) |
| `ina219` | I2C | `busVoltage` (V), `current` (mA) |
| `mlx90614` | I2C | `objectTemp`, `ambientTemp` |
| `qmc5883l` | I2C | `heading` |
| `ccs811` | I2C | `eco2`, `tvoc` |
| `bme280` | I2C | `temperature`, `humidity`, `pressure` |
| `bmp180` | I2C | `temperature`, `pressure` |
| `bme680` | I2C | `temperature`, `humidity`, `pressure`, `gas` (kΩ) |
| `vl53l0x` | I2C | `distance` (mm) |
| `max30102` | I2C | `bpm`, `finger` |
| `max6675`, `max31865` | SPI | `temperature` |
| `rc522` | SPI | `card` (0/1), `tag` (preset UID 0..3) |
| `ds18b20` | 1-Wire | `temperature` |
| `tm1637`, `max7219` | display | none: `"controls": []`, the module draws what the sketch sends |
| `regmap` | I2C / SPI | the card's own: `sim.regmap` describes the chip (below) |

Models answer on boards simulated in the browser (Uno, Nano, Mega, Pico) and
on ESP32. An ESP32 runs its firmware in a backend QEMU worker, so each model
has a Python twin there that answers the guest byte for byte as the tab's
model answers an Uno (backend/tests/test_catalog_*.py hold the byte vectors):

| Models | Worker file |
|---|---|
| `bh1750`, `aht20`, `sht31`, `bme280` | backend/app/services/catalog_i2c_models.py |
| `adxl345`, `ina219`, `mlx90614`, `qmc5883l`, `ccs811` | catalog_i2c_simple.py |
| `bmp180`, `bme680` | catalog_i2c_bosch.py |
| `vl53l0x`, `max30102` | catalog_i2c_complex.py (on the guest clock) |
| `max6675`, `max31865`, `rc522` | catalog_spi_models.py (MAX6675 bit-banged) |
| `ds18b20` | esp32_onewire.py (the run uses `-icount`, so the ESP32 boots slower) |
| `dht11` | the worker's own DHT model |

`tm1637` and `max7219` need no twin: the tab decodes the pins the worker
reports. A change to a model's answers goes into both its TS file and its
Python twin. Analog and digital outputs work on every board (ESP32: ADC1 pins
only). A new model starts in the browser only; list it in `ESP32_SIM_MODELS`
(frontend/src/partsCatalog/catalog.ts and ai-bridge/partCards.mjs) once its
twin exists.

### Register map (`"model": "regmap"`)

A chip with no hand-written model that reads as a register file is described
in the card itself, and one engine answers from that description: the tab's
(frontend/src/partsCatalog/regmap.ts) on Uno, Nano, Mega and Pico, its Python
twin (backend/app/services/catalog_regmap.py) on ESP32. Both pass the cases in
frontend/src/__tests__/fixtures/regmap-vectors.json.

```json
"sim": {
  "model": "regmap",
  "controls": [{ "key": "temperature", "label": "Temperature", "min": -55, "max": 125, "step": 0.5, "unit": "°C", "default": 24 }],
  "regmap": {
    "bus": "i2c",
    "width": 2,
    "registers": { "0x01": "0x00" },
    "values": [{ "reg": "0x00", "from": "temperature", "bytes": 2, "signed": true, "scale": 2, "shift": 7 }]
  }
}
```

Fields: `bus` ("i2c" | "spi"), `pointer` (address bytes 0/1/2, default 1),
`width` (bytes per register 1/2, default 1), SPI `spiMode`, `readBit`,
`readWhen`, `addressMask`; `registers` (power-on bytes), `values` (readings:
`reg`, `from`, `bytes`, `order`, `signed`, `scale`/`offset` or `points`,
`shift`, `or`). The field reference is the comment block of regmap.ts. The
AI's card check (ai-bridge/simCheck.mjs) runs the example on a Nano and an
ESP32 and requires the printed numbers to follow the panel.

Groups: `climate`, `light`, `distance`, `motion`, `air`, `water`, `electrical`,
`biometric`, `touch`, `rfid`, `sound`, `display`, `other`.
