# Custom Chips — Examples walkthrough

Velxio ships an in-app gallery of 11 example chips. Each one is a complete,
working chip you can study, fork, and modify. They cover every protocol the
runtime supports: GPIO, I2C, SPI, UART, attributes, timers.

The C source for all of them lives at:

- [`test/test_custom_chips/sdk/examples/`](../../test/test_custom_chips/sdk/examples/)
- (Same files copied into the frontend bundle at `frontend/src/components/customChips/examples/` for the gallery UI)

Each example is also covered by automated tests in
[`test/test_custom_chips/test/`](../../test/test_custom_chips/test/) — read
those alongside the C source to see the expected behavior under load.

---

## The galleria

| # | Chip | Tier | Protocol | Lines of C |
|---|---|---|---|---|
| 1 | [Inverter](#1-inverter)               | Beginner | GPIO + watch       | ~25 |
| 2 | [XOR Gate](#2-xor-gate)               | Beginner | GPIO × 2 + watch   | ~30 |
| 3 | [Pulse Counter](#3-pulse-counter)     | Beginner | GPIO + attributes  | ~35 |
| 4 | [CD4094](#4-cd4094-shift-register)    | Intermediate | GPIO + state machine | ~70 |
| 5 | [74HC595](#5-74hc595-spi-shift-register) | Intermediate | SPI slave | ~75 |
| 6 | [MCP3008](#6-mcp3008-spi-adc)         | Intermediate | SPI + analog       | ~85 |
| 7 | [PCF8574](#7-pcf8574-io-expander)     | Intermediate | I2C slave + GPIO bidir | ~75 |
| 8 | [24C01 EEPROM](#8-24c01-eeprom)       | Intermediate | I2C slave          | ~80 |
| 9 | [24LC256 EEPROM](#9-24lc256-eeprom)   | Advanced | I2C 16-bit addressing  | ~90 |
| 10 | [DS3231 RTC](#10-ds3231-rtc)         | Advanced | I2C state + BCD    | ~110 |
| 11 | [ROT13 UART](#11-rot13-uart)         | Intermediate | UART RX/TX        | ~50 |
| 12 | [SX1262 LoRa](#12-sx1262-lora)       | Advanced | SPI slave + timers + chip-to-chip net | ~760 |
| 13 | [KQ-130F Power-Line](#13-kq-130f-power-line) | Advanced | UART + timers + chip-to-chip net | ~430 |

---

## 1. Inverter

OUT is always the inverse of IN.

**Why study it**: simplest possible chip. Shows the full lifecycle:
allocate state, register pins, watch one input, react.

```c
typedef struct { vx_pin in, out; } chip_state_t;

static void on_in_change(void *ud, vx_pin pin, int value) {
  chip_state_t *s = ud;
  vx_pin_write(s->out, value ? VX_LOW : VX_HIGH);
}

void chip_setup(void) {
  chip_state_t *s = malloc(sizeof(chip_state_t));
  s->in  = vx_pin_register("IN",  VX_INPUT);
  s->out = vx_pin_register("OUT", VX_OUTPUT);
  vx_pin_write(s->out, vx_pin_read(s->in) ? VX_LOW : VX_HIGH);
  vx_pin_watch(s->in, VX_EDGE_BOTH, on_in_change, s);
}
```

`chip.json`:
```json
{ "name": "Inverter", "pins": ["IN", "OUT", "GND", "VCC"], "attributes": [] }
```

**Tested by**: [`test/chips/01_inverter.test.js`](../../test/test_custom_chips/test/chips/01_inverter.test.js) (3 tests).

---

## 2. XOR Gate

OUT = A xor B. Demonstrates watching multiple inputs.

```c
typedef struct { vx_pin a, b, out; } chip_state_t;

static void update_output(chip_state_t* s) {
  int a = vx_pin_read(s->a);
  int b = vx_pin_read(s->b);
  vx_pin_write(s->out, (a ^ b) ? VX_HIGH : VX_LOW);
}

static void on_input_change(void *ud, vx_pin pin, int value) {
  update_output(ud);
}

void chip_setup(void) {
  chip_state_t *s = malloc(sizeof(chip_state_t));
  s->a   = vx_pin_register("A",   VX_INPUT);
  s->b   = vx_pin_register("B",   VX_INPUT);
  s->out = vx_pin_register("OUT", VX_OUTPUT);
  vx_pin_watch(s->a, VX_EDGE_BOTH, on_input_change, s);
  vx_pin_watch(s->b, VX_EDGE_BOTH, on_input_change, s);
  update_output(s);
}
```

**Pattern**: when output depends on multiple inputs, write a single
`update_output()` and call it from every input's watch.

---

## 3. Pulse Counter

Counts rising edges on `PULSE`. Toggles `OVF` every N pulses, where N is
user-editable from the UI.

**Why study it**: shows attributes (`vx_attr_register`/`vx_attr_read`) and
how the UI's slider value flows into the chip at runtime.

```c
typedef struct {
  vx_pin pulse, ovf, rst;
  vx_attr threshold;
  uint32_t count;
  int ovf_state;
} chip_state_t;

static void on_pulse(void *ud, vx_pin p, int v) {
  chip_state_t *s = ud;
  s->count++;
  uint32_t threshold = (uint32_t)vx_attr_read(s->threshold);  // re-read live
  if (s->count >= threshold) {
    s->count = 0;
    s->ovf_state = !s->ovf_state;
    vx_pin_write(s->ovf, s->ovf_state);
  }
}

static void on_reset(void *ud, vx_pin p, int v) {
  chip_state_t *s = ud;
  s->count = 0;
  s->ovf_state = 0;
  vx_pin_write(s->ovf, VX_LOW);
}

void chip_setup(void) {
  chip_state_t *s = calloc(1, sizeof(chip_state_t));
  s->pulse     = vx_pin_register("PULSE", VX_INPUT);
  s->ovf       = vx_pin_register("OVF",   VX_OUTPUT_LOW);
  s->rst       = vx_pin_register("RST",   VX_INPUT_PULLUP);
  s->threshold = vx_attr_register("threshold", 4.0);
  vx_pin_watch(s->pulse, VX_EDGE_RISING,  on_pulse, s);
  vx_pin_watch(s->rst,   VX_EDGE_FALLING, on_reset, s);
}
```

`chip.json`:
```json
{
  "pins": ["PULSE", "OVF", "RST", "GND", "VCC"],
  "attributes": [
    { "name": "threshold", "type": "int", "default": 4, "min": 1, "max": 1024 }
  ]
}
```

The user gets a slider labeled "threshold" with range 1..1024. Move it
during simulation → next pulse picks up the new value.

---

## 4. CD4094 shift register

8-stage shift-and-store bus register. Real-world chip with three control
pins (CLK / DATA / STR), parallel outputs Q1..Q8, and cascade outputs.

**Why study it**: state machine with multiple input watches, edge masks
(`VX_EDGE_RISING` for STR, `VX_EDGE_BOTH` for CLK), and a "no power" guard.

Highlights:

```c
static int has_power(chip_state_t *s) {
  return vx_pin_read(s->VDD) && !vx_pin_read(s->VSS);
}

static void on_clk_change(void *ud, vx_pin pin, int value) {
  chip_state_t *s = ud;
  if (!has_power(s)) {
    for (int i = 0; i < 8; i++) vx_pin_write(s->Q[i], VX_LOW);
    return;
  }
  if (vx_pin_read(s->CLK)) {
    /* rising edge: shift DATA into bit position s->bit */
    if (vx_pin_read(s->DATA)) s->reg |= (1 << s->bit);
    else                      s->reg &= ~(1 << s->bit);
    s->bit = s->bit > 0 ? s->bit - 1 : 7;
  }
}

static void on_strobe_change(void *ud, vx_pin pin, int value) {
  chip_state_t *s = ud;
  for (int i = 0; i < 8; i++) {
    vx_pin_write(s->Q[i], (s->reg >> i) & 1 ? VX_HIGH : VX_LOW);
  }
}

void chip_setup(void) {
  chip_state_t *s = calloc(1, sizeof(chip_state_t));
  /* register VDD/VSS/CLK/DATA/STR/OE/QS/QSN and Q1..Q8 */
  vx_pin_watch(s->CLK, VX_EDGE_BOTH,    on_clk_change,    s);
  vx_pin_watch(s->STR, VX_EDGE_RISING,  on_strobe_change, s);
}
```

**Tested by**: [`test/chips/03_cd4094.test.js`](../../test/test_custom_chips/test/chips/03_cd4094.test.js) (4 tests including a power-gate test).

---

## 5. 74HC595 SPI shift register

8-bit SIPO shift register driven over SPI.

**Why study it**: SPI **without CS** — the chip shifts on every SCK clock
as long as data flows, so it must re-arm `vx_spi_start` after each byte.

```c
static void on_spi_done(void *ud, uint8_t *buffer, uint32_t count) {
  chip_state_t *s = ud;
  if (count > 0) s->shift_reg = buffer[0];
  vx_spi_start(s->spi, s->spi_buf, 1);   // re-arm immediately
}

static void on_rclk(void *ud, vx_pin pin, int value) {
  chip_state_t *s = ud;
  s->latch_reg = s->shift_reg;
  for (int i = 0; i < 8; i++) {
    vx_pin_write(s->Q[i], (s->latch_reg >> i) & 1);
  }
}

void chip_setup(void) {
  chip_state_t *s = calloc(1, sizeof(chip_state_t));
  /* register SER/SRCLK/RCLK/SRCLR/OE/QH and Q0..Q7 */
  vx_spi_config cfg = {
    .sck = s->SRCLK, .mosi = s->SER, .miso = s->QH,
    .cs = s->RCLK, .mode = 0, .on_done = on_spi_done, .user_data = s,
  };
  s->spi = vx_spi_attach(&cfg);
  vx_spi_start(s->spi, s->spi_buf, 1);   // arm initial transfer

  vx_pin_watch(s->RCLK,  VX_EDGE_RISING,  on_rclk,  s);
}
```

**Pattern**: chips with a real CS pin should call `vx_spi_start` /
`vx_spi_stop` from a CS pin watch instead. See MCP3008 below.

---

## 6. MCP3008 SPI ADC

8-channel, 10-bit ADC.

**Why study it**: SPI with CS-driven transactions, a chip that answers
inside the same byte it is being asked in (`on_exchange`), a look-ahead
buffer for bit-banged masters, and analog reads via `vx_pin_read_analog`.

The MCP3008 has no byte framing: after CS falls it takes a start bit, four
configuration bits, samples, sends a null bit and then the 10-bit result. The
common drivers put the first result bits in the SAME byte as the
configuration bits, so a buffer filled before that byte arrives cannot hold
them. The chip models the bit stream and shifts each byte through it:

```c
/* One clock edge: DIN in, DOUT out. */
static int clock_bit(const chip_state_t *s, frame_t *f, int din) {
  switch (f->phase) {
    case IDLE:     if (din) { f->phase = CONFIG; f->cfg = 0; f->cfg_bits = 0; } return 0;
    case CONFIG:   f->cfg = (f->cfg << 1) | din;
                   if (++f->cfg_bits == 4) f->phase = SAMPLE;
                   return 0;
    case SAMPLE:   f->result = convert(s, f->cfg); f->phase = NULL_BIT; return 0;
    case NULL_BIT: f->phase = MSB; f->bit = 9; return 0;
    case MSB: {    int out = (f->result >> f->bit) & 1;
                   if (f->bit-- == 0) { f->phase = LSB; f->bit = 1; }
                   return out; }
    /* ... LSB-first repeat, then zeros until CS rises */
  }
}

/* A hardware controller clocked one whole byte. */
static uint8_t on_spi_exchange(void *ud, uint8_t mosi) {
  chip_state_t *s = ud;
  uint8_t miso = clock_byte(s, &s->f, mosi);
  arm(s);                        /* refresh the look-ahead byte */
  return miso;
}

/* CS moved either way: back to waiting for a start bit, still armed. */
static void on_cs_change(void *ud, vx_pin pin, int value) {
  chip_state_t *s = ud;
  s->f.phase = IDLE;
  arm(s);
}
```

`arm()` clocks a COPY of the frame with DIN low and puts the resulting byte
in the `vx_spi_start` buffer: that is what a bit-banged master (`shiftIn`,
the Pi's `readadc` loop) reads bit by bit before its own byte is complete.
`on_done` catches the real frame up when that buffer is consumed, so both
kinds of master read the same code.

**Pattern**: a chip whose answer depends on bits of the byte it is receiving
sets `on_exchange` and keeps a look-ahead byte armed. A chip that answers a
command in the bytes AFTER it (a register file, a flash) can stay on the
buffer alone. Either way, restart the protocol from the CS watch: the bus
puts the select edge on that pin even when the controller drives it in
hardware.

---

## 7. PCF8574 IO expander

8-bit I2C IO expander. Master writes a byte → 8 GPIO pins reflect that
byte. Master reads → returns the current state of the 8 pins.

```c
static bool on_write(void *ud, uint8_t byte) {
  chip_state_t *s = ud;
  s->latched = byte;
  for (int i = 0; i < 8; i++) {
    vx_pin_write(s->P[i], (byte >> i) & 1);
  }
  return true;
}

static uint8_t on_read(void *ud) {
  chip_state_t *s = ud;
  uint8_t v = 0;
  for (int i = 0; i < 8; i++) {
    if (vx_pin_read(s->P[i])) v |= (1 << i);
  }
  return v;
}
```

**Address**: A0/A1/A2 are read at `chip_setup()` time and form the low 3
bits of the 7-bit address (base 0x20). Wire them HIGH/LOW differently to
put two chips on the same bus at 0x20 and 0x21.

---

## 8. 24C01 EEPROM

128-byte I2C EEPROM with a write pointer that auto-increments.

**Why study it**: classic I2C protocol with an internal state machine
(IDLE → HAS_POINTER) and the standard "first byte after addressing is the
register pointer" pattern.

See the full code in
[API reference → I2C example](./custom-chips-api-reference.md#example-24c01-eeprom).

**Tested by**: [`test/chips/04_eeprom_24c01.test.js`](../../test/test_custom_chips/test/chips/04_eeprom_24c01.test.js) — 4 tests covering basic write/read, auto-increment, wrap at 0x80, and address-pin selection. Also full E2E with a real Arduino sketch using `Wire.h` in [`test/e2e/07_chip_eeprom_avr_e2e.test.js`](../../test/test_custom_chips/test/e2e/07_chip_eeprom_avr_e2e.test.js).

---

## 9. 24LC256 EEPROM

32 KB I2C EEPROM. Same idea as 24C01 but with **two-byte** addressing.

```c
typedef enum { ST_IDLE, ST_HAS_HIGH, ST_HAS_FULL_ADDRESS } ee_state;

static bool i2c_write(void *ud, uint8_t byte) {
  chip_state_t *s = ud;
  switch (s->state) {
    case ST_IDLE:
      s->pointer = (byte & 0x7f) << 8;       // address high
      s->state = ST_HAS_HIGH;
      break;
    case ST_HAS_HIGH:
      s->pointer = (s->pointer & 0xff00) | byte;   // address low
      s->state = ST_HAS_FULL_ADDRESS;
      break;
    case ST_HAS_FULL_ADDRESS:
      s->mem[s->pointer & (EEPROM_SIZE - 1)] = byte;
      s->pointer = (s->pointer + 1) & (EEPROM_SIZE - 1);
      break;
  }
  return true;
}
```

The state machine grows naturally as the protocol gets richer. Same pattern
extends to 24LC512, 24LC1024, and other big EEPROMs.

---

## 10. DS3231 RTC

I2C real-time clock with 19 registers and BCD-encoded values.

**Why study it**: register pointer + multi-register read auto-increment +
encoded values. This is the workhorse pattern for most I2C peripherals
(sensors, displays, motor drivers).

```c
static bool on_write(void *ud, uint8_t byte) {
  chip_state_t *s = ud;
  if (s->state == ST_IDLE) {
    s->pointer = byte % RTC_REG_COUNT;     // first byte = register pointer
    s->state = ST_HAS_POINTER;
  } else {
    s->regs[s->pointer] = byte;            // subsequent bytes = data
    s->pointer = (s->pointer + 1) % RTC_REG_COUNT;
  }
  return true;
}

static uint8_t on_read(void *ud) {
  chip_state_t *s = ud;
  uint8_t b = s->regs[s->pointer];
  s->pointer = (s->pointer + 1) % RTC_REG_COUNT;
  return b;
}
```

**Seed values**: this chip pre-seeds time to 2026-01-15 12:34:56 (Thursday)
inside `chip_setup`. A real RTC would tick — extending this with a 1-second
timer is a great exercise.

---

## 11. ROT13 UART

UART loopback that ROT13-shifts every received byte.

**Why study it**: simplest possible UART chip. Establishes the pattern for
any UART peripheral (GPS modules, BT modems, anything Serial-based).

```c
static uint8_t rot13(uint8_t v) {
  if (v >= 'A' && v <= 'Z') return ((v - 'A' + 13) % 26) + 'A';
  if (v >= 'a' && v <= 'z') return ((v - 'a' + 13) % 26) + 'a';
  return v;
}

static void on_rx(void *ud, uint8_t byte) {
  chip_state_t *s = ud;
  uint8_t out = rot13(byte);
  vx_uart_write(s->uart, &out, 1);
}

void chip_setup(void) {
  chip_state_t *s = malloc(sizeof(chip_state_t));
  vx_uart_config cfg = {
    .rx          = vx_pin_register("RX", VX_INPUT),
    .tx          = vx_pin_register("TX", VX_INPUT_PULLUP),
    .baud_rate   = 115200,
    .on_rx_byte  = on_rx,
    .on_tx_done  = NULL,
    .user_data   = s,
  };
  s->uart = vx_uart_attach(&cfg);
}
```

When wired to the Arduino's `Serial`, every `Serial.print('A')` from the
sketch makes the chip echo `'N'` — visible in the Serial Monitor.

---

## 12. SX1262 LoRa

A model of the Semtech SX1262 transceiver by Martin Thuku (MIT). SPI slave
on NSS/SCK/MOSI/MISO with BUSY, DIO1 and RESET, implementing the command
sequence a real driver runs (SetStandby, SetRfFrequency, WriteBuffer, SetTx,
SetRx, GetIrqStatus, ...). The `ANT` pin is the air: the chip serialises its
TX buffer onto it as a Manchester bit stream with a CRC, and every SX1262
wired to the same `ANT` net decodes it into its RX buffer. Attributes: RSSI
reported to the sketch, frame drop percentage, air bit period.

Wire two of them, one per board, `ANT` to `ANT`, and a frame sent on one
board arrives on the other. On ESP32 boards the two chips run in two QEMU
workers and the net crosses through the bridge described in
[custom-chips-chip-nets.md](./custom-chips-chip-nets.md); the bit period has
to sit around 40 ms there. What it does not model: LoRa modulation,
spreading factors, airtime, sensitivity.

## 13. KQ-130F Power-Line

A model of the KQ-130F narrowband power-line carrier module, same author
and licence. 9600 8N1 UART on TX/RX plus a synthetic `LINE` pin that is the
mains: bytes arriving on RX are framed onto `LINE` (up to 128 per burst),
and every other KQ-130F on the same `LINE` net replays them on its TX once
the frame completes, CRC permitting. Attributes: line noise percentage and
line bit period. The UART binds to whichever hardware UART the sketch's
TX/RX pins are wired to.

## How to learn from these

A productive workflow:

1. **Pick the example closest to what you want to build.** EEPROM-like? Start
   from 24C01. Logic gate? Start from XOR. Display? See the chip with a
   `display` field in `chip.json`.
2. **Open it in the Custom Chip Designer.** Examples tab → click the chip.
3. **Modify it.** Change a constant, add a pin, adjust a callback.
4. **Compile and place it.** Save & Place puts it on the canvas.
5. **Wire it up.** The Arduino sketch in your editor talks to it via the
   normal Wire/SPI/Serial APIs.
6. **Run.** The chip console (browser dev tools) shows your `vx_log` /
   `printf` output.

If something breaks, see [Build & test → Troubleshooting](./custom-chips-build-and-test.md#troubleshooting).
