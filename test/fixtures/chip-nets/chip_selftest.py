"""Functional self test for the chip-nets fixture models (SX1262, KQ-130F).

Runs INSIDE the velxio container, driving the compiled chip.wasm through
velxio's own runtime class (app.services.wasm_chip_runtime.WasmChipRuntime,
the same class the ESP32 QEMU worker uses). No board, no QEMU: the harness
plays the part of the wiring, so the models can be proven independently of
velxio's board-level limits (see docs/wiki/custom-chips-chip-nets.md, "Limits").

Usage (from the repo root, with the container named velxio running):

    docker cp test/fixtures/chip-nets/chip_selftest.py velxio:/tmp/
    # compile the two models first (the .wasm is not checked in), see README.md
    docker exec velxio python3 /tmp/chip_selftest.py

Exit code 0 means every case passed.
"""

from __future__ import annotations

import sys

sys.path.insert(0, "/app")

from app.services.wasm_chip_runtime import WasmChipRuntime  # noqa: E402

SX_WASM = "/tmp/sx1262.wasm"
KQ_WASM = "/tmp/kq130f.wasm"

# Both media carry a self clocked bit stream, so the receivers measure edge
# intervals. Driving them from a wall clock Python loop puts scheduler jitter
# straight into those measurements (measured: single intervals off by up to
# half a cell, which is exactly the Manchester discrimination margin). The
# harness therefore runs on VIRTUAL time: sim_now_nanos is redirected to a
# clock the harness advances to the next timer deadline, so the models are
# tested against their own timing rather than against the host's scheduler.
# Host jitter tolerance is a separate property, documented in the README.
NOW = [0]


def _virtual_now(_self) -> int:
    return NOW[0]


WasmChipRuntime.sim_now_nanos = _virtual_now

# The chip.json defaults, so the test proves the shipped values.
SX_BIT_US = 20.0
KQ_BIT_US = 200.0

FAILURES: list[str] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    print(f"  [{'PASS' if ok else 'FAIL'}] {name}{(' - ' + detail) if detail else ''}")
    if not ok:
        FAILURES.append(name)


class Net:
    """One shared digital net map: gpio number -> level, fanned out to every
    runtime that watches it. Models an ideal wire with last writer wins."""

    def __init__(self) -> None:
        self.level: dict[int, int] = {}
        self.runtimes: list[WasmChipRuntime] = []

    def writer(self, gpio: int, value: int) -> None:
        value &= 1
        if self.level.get(gpio) == value:
            return
        self.level[gpio] = value
        for rt in self.runtimes:
            rt.notify_pin_change(gpio, value)

    def reader(self, gpio: int) -> int:
        return self.level.get(gpio, 0)


def make_logger(tag: str):
    def emit(payload: dict) -> None:
        if payload.get("type") in ("chip_log", "chip_warning", "chip_error"):
            msg = (payload.get("text") or payload.get("message")
                   or payload.get("error") or payload)
            print(f"    {tag} {msg}")

    return emit


def pump(runtimes, max_events: int = 4_000_000, stop=None) -> bool:
    """Advance virtual time to the next timer deadline and fire it, until
    `stop()` is satisfied or no timer is left armed."""
    for _ in range(max_events):
        if stop is not None and stop():
            return True
        deadlines = [d for d in (rt.next_timer_deadline() for rt in runtimes)
                     if d is not None]
        if not deadlines:
            break
        NOW[0] = max(NOW[0], min(deadlines))
        for rt in runtimes:
            rt.fire_due_timers()
    return stop() is True if stop is not None else True


# --------------------------------------------------------------------------
# SX1262 over ANT
# --------------------------------------------------------------------------

SX_PINS = ["SCK", "MOSI", "MISO", "NSS", "BUSY", "DIO1", "RESET", "ANT"]

OP = {
    "SET_STANDBY": 0x80,
    "SET_PACKET_TYPE": 0x8A,
    "SET_RF_FREQUENCY": 0x86,
    "SET_PA_CONFIG": 0x95,
    "SET_TX_PARAMS": 0x8E,
    "SET_BUFFER_BASE": 0x8F,
    "SET_MOD_PARAMS": 0x8B,
    "SET_PACKET_PARAMS": 0x8C,
    "SET_DIO_IRQ": 0x08,
    "WRITE_BUFFER": 0x0E,
    "READ_BUFFER": 0x1E,
    "WRITE_REGISTER": 0x0D,
    "READ_REGISTER": 0x1D,
    "SET_TX": 0x83,
    "SET_RX": 0x82,
    "GET_STATUS": 0xC0,
    "GET_IRQ_STATUS": 0x12,
    "CLEAR_IRQ_STATUS": 0x02,
    "GET_RX_BUFFER_STATUS": 0x13,
    "GET_PACKET_STATUS": 0x14,
    "SET_REGULATOR_MODE": 0x96,
    "SET_DIO2_AS_RF_SWITCH": 0x9D,
    "SET_DIO3_AS_TCXO": 0x97,
    "CALIBRATE_IMAGE": 0x98,
}


class Radio:
    def __init__(self, net: Net, tag: str, base: int, ant_gpio: int, attrs: dict):
        self.net = net
        self.tag = tag
        self.map = {name: base + i for i, name in enumerate(SX_PINS)}
        self.map["ANT"] = ant_gpio
        self.rt = WasmChipRuntime(
            open(SX_WASM, "rb").read(),
            attrs,
            make_logger(tag),
            pin_map=self.map,
            pin_writer=net.writer,
            pin_reader=net.reader,
        )
        net.runtimes.append(self.rt)
        self.rt.run_chip_setup()
        # Establish NSS idle high so the first assertion is a real falling edge.
        self.rt.notify_pin_change(self.map["NSS"], 1)

    def xfer(self, data) -> list[int]:
        nss = self.map["NSS"]
        self.rt.notify_pin_change(nss, 0)
        out = [self.rt.spi_transfer_byte(b) for b in data]
        self.rt.notify_pin_change(nss, 1)
        return out

    def cmd(self, op: str, args=()) -> list[int]:
        return self.xfer([OP[op]] + list(args))

    def dio1(self) -> int:
        return self.net.reader(self.map["DIO1"])

    def busy(self) -> int:
        return self.net.reader(self.map["BUSY"])

    def irq(self) -> int:
        r = self.cmd("GET_IRQ_STATUS", [0, 0, 0])
        return (r[2] << 8) | r[3]

    def configure(self, dio1_mask: int) -> None:
        self.cmd("SET_STANDBY", [0x00])
        self.cmd("SET_REGULATOR_MODE", [0x01])
        self.cmd("SET_DIO2_AS_RF_SWITCH", [0x01])
        self.cmd("SET_DIO3_AS_TCXO", [0x07, 0x00, 0x00, 0x64])
        self.cmd("CALIBRATE_IMAGE", [0xD7, 0xDB])
        self.cmd("SET_PACKET_TYPE", [0x01])
        self.cmd("SET_RF_FREQUENCY", [0x36, 0x40, 0x66, 0x66])
        self.cmd("SET_PA_CONFIG", [0x04, 0x07, 0x00, 0x01])
        self.cmd("SET_TX_PARAMS", [0x16, 0x04])
        self.cmd("SET_BUFFER_BASE", [0x00, 0x80])
        self.cmd("SET_MOD_PARAMS", [0x07, 0x04, 0x01, 0x00])
        self.cmd("SET_PACKET_PARAMS", [0x00, 0x08, 0x00, 0xFF, 0x01, 0x00])
        self.cmd("SET_DIO_IRQ", [0xFF, 0xFF, dio1_mask >> 8, dio1_mask & 0xFF,
                                 0x00, 0x00, 0x00, 0x00])


def test_sx1262() -> None:
    print("\nSX1262: two radios, one ANT net")
    net = Net()
    attrs = {"rssi_dbm": -80.0, "drop_percent": 0.0,
             "bit_period_us": SX_BIT_US, "label": "radioA"}
    a = Radio(net, "A>", 10, 99, dict(attrs, label="radioA"))
    b = Radio(net, "B>", 30, 99, dict(attrs, label="radioB"))
    rts = [a.rt, b.rt]

    st = a.cmd("GET_STATUS", [0x00])
    check("GetStatus reports STDBY_RC", st[1] == 0x22, f"status=0x{st[1]:02X}")

    a.cmd("WRITE_REGISTER", [0x07, 0x40, 0xAB])
    rr = a.cmd("READ_REGISTER", [0x07, 0x40, 0x00, 0x00])
    check("WriteRegister then ReadRegister round trips", rr[4] == 0xAB,
          f"read=0x{rr[4]:02X}")

    a.configure(0x0001)   # TX_DONE on DIO1
    b.configure(0x0002)   # RX_DONE on DIO1
    pump(rts)  # let the BUSY release timer fire
    check("BUSY returns low after a command", a.busy() == 0)

    b.cmd("SET_RX", [0xFF, 0xFF, 0xFF])
    payload = b"xkoin ping 1"
    a.cmd("WRITE_BUFFER", [0x00] + list(payload))
    rb = a.cmd("READ_BUFFER", [0x00, 0x00] + [0] * len(payload))
    check("WriteBuffer then ReadBuffer round trips",
          bytes(rb[3:3 + len(payload)]) == payload, repr(bytes(rb[3:3 + len(payload)])))

    a.cmd("SET_TX", [0xFF, 0xFF, 0xFF])
    ok = pump(rts, stop=lambda: a.dio1() == 1 and b.dio1() == 1)
    check("TX_DONE raised DIO1 on the sender", a.dio1() == 1)
    check("RX_DONE raised DIO1 on the receiver", b.dio1() == 1, f"pump_ok={ok}")

    irq_b = b.irq()
    check("receiver IRQ has RX_DONE and no CRC_ERR",
          bool(irq_b & 0x0002) and not (irq_b & 0x0040), f"irq=0x{irq_b:04X}")

    rbs = b.cmd("GET_RX_BUFFER_STATUS", [0, 0, 0])
    got_len, got_start = rbs[2], rbs[3]
    check("GetRxBufferStatus length matches", got_len == len(payload),
          f"len={got_len} start=0x{got_start:02X}")

    rd = b.cmd("READ_BUFFER", [got_start, 0x00] + [0] * got_len)
    got = bytes(rd[3:3 + got_len])
    check("payload crossed the ANT net intact", got == payload, repr(got))

    ps = b.cmd("GET_PACKET_STATUS", [0, 0, 0, 0])
    check("GetPacketStatus reports rssi_dbm = -80", ps[2] == 160, f"rssiPkt={ps[2]}")

    b.cmd("CLEAR_IRQ_STATUS", [0xFF, 0xFF])
    check("ClearIrqStatus lowers DIO1", b.dio1() == 0)

    # Collision: two senders on the medium at once must not deliver a frame.
    print("  collision case: two radios transmit into one listener")
    net2 = Net()
    c1 = Radio(net2, "C1>", 10, 99, dict(attrs, label="tx1"))
    c2 = Radio(net2, "C2>", 30, 99, dict(attrs, label="tx2"))
    c3 = Radio(net2, "C3>", 50, 99, dict(attrs, label="listener"))
    for r in (c1, c2, c3):
        r.configure(0x0002)
    c3.cmd("SET_RX", [0xFF, 0xFF, 0xFF])
    c1.cmd("WRITE_BUFFER", [0x00] + list(b"aaaaaaaaaaaa"))
    c2.cmd("WRITE_BUFFER", [0x00] + list(b"bbbbbbbbbbbb"))
    c1.cmd("SET_TX", [0xFF, 0xFF, 0xFF])
    c2.cmd("SET_TX", [0xFF, 0xFF, 0xFF])
    pump([c1.rt, c2.rt, c3.rt])
    irq_c3 = c3.irq()
    delivered = bool(irq_c3 & 0x0002) and not (irq_c3 & 0x0040)
    check("collision does not deliver a clean frame", not delivered,
          f"irq=0x{irq_c3:04X}")

    # drop_percent 100 must swallow an otherwise good frame.
    print("  drop_percent case")
    net3 = Net()
    d1 = Radio(net3, "D1>", 10, 99, dict(attrs, label="sender"))
    d2 = Radio(net3, "D2>", 30, 99,
               dict(attrs, label="deaf", drop_percent=100.0))
    d1.configure(0x0001)
    d2.configure(0x0002)
    d2.cmd("SET_RX", [0xFF, 0xFF, 0xFF])
    d1.cmd("WRITE_BUFFER", [0x00] + list(b"xkoin ping 2"))
    d1.cmd("SET_TX", [0xFF, 0xFF, 0xFF])
    pump([d1.rt, d2.rt], stop=lambda: d1.dio1() == 1)
    pump([d1.rt, d2.rt])
    check("drop_percent 100 suppresses RX_DONE", d2.dio1() == 0,
          f"irq=0x{d2.irq():04X}")


# --------------------------------------------------------------------------
# KQ-130F over LINE
# --------------------------------------------------------------------------

KQ_PINS = ["TX", "RX", "LINE"]


class Plc:
    def __init__(self, net: Net, tag: str, base: int, line_gpio: int, attrs: dict):
        self.tag = tag
        self.out = bytearray()
        self.map = {name: base + i for i, name in enumerate(KQ_PINS)}
        self.map["LINE"] = line_gpio
        self.rt = WasmChipRuntime(
            open(KQ_WASM, "rb").read(),
            attrs,
            make_logger(tag),
            pin_map=self.map,
            pin_writer=net.writer,
            pin_reader=net.reader,
            uart_writer=lambda data: self.out.extend(data),
        )
        net.runtimes.append(self.rt)
        self.rt.run_chip_setup()

    def host_send(self, data: bytes) -> None:
        for b in data:
            self.rt.feed_uart_byte(b)


def test_kq130f() -> None:
    print("\nKQ-130F: two modules, one LINE net")
    net = Net()
    attrs = {"line_noise_percent": 0.0, "bit_period_us": KQ_BIT_US}
    a = Plc(net, "A>", 10, 99, dict(attrs, label="plcA"))
    b = Plc(net, "B>", 30, 99, dict(attrs, label="plcB"))
    rts = [a.rt, b.rt]

    msg = b"xkoin plc 1\n"
    a.host_send(msg)
    got = pump(rts, stop=lambda: bytes(b.out) == msg)
    check("bytes crossed the LINE net intact", bytes(b.out) == msg,
          f"got={bytes(b.out)!r} pump_ok={got}")
    check("sender did not hear itself", bytes(a.out) == b"",
          f"got={bytes(a.out)!r}")

    print("  128 byte payload limit")
    net2 = Net()
    c = Plc(net2, "C>", 10, 99, dict(attrs, label="plcC"))
    d = Plc(net2, "D>", 30, 99, dict(attrs, label="plcD"))
    big = bytes((0x41 + (i % 26)) for i in range(200))
    c.host_send(big)
    pump([c.rt, d.rt], stop=lambda: len(d.out) >= 128)
    check("first burst carries exactly the 128 byte limit",
          bytes(d.out)[:128] == big[:128] and len(d.out) >= 128,
          f"got {len(d.out)} bytes")

    print("  line_noise_percent case")
    net3 = Net()
    e = Plc(net3, "E>", 10, 99, dict(attrs, label="plcE"))
    f = Plc(net3, "F>", 30, 99, dict(attrs, label="plcF", line_noise_percent=100.0))
    e.host_send(b"xkoin plc 2\n")
    pump([e.rt, f.rt])
    check("line_noise_percent 100 fails the CRC and drops the burst",
          bytes(f.out) == b"", f"got={bytes(f.out)!r}")


if __name__ == "__main__":
    test_sx1262()
    test_kq130f()
    print()
    if FAILURES:
        print(f"FAILED: {len(FAILURES)} case(s): {', '.join(FAILURES)}")
        sys.exit(1)
    print("All cases passed.")
