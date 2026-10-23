"""WasmChipI2CSlave: adapts a WasmChipRuntime to the QEMU I2C slave interface.

Implements the same `handle_event(event: int) -> int` contract that
MPU6050Slave / BMP280Slave / DS1307Slave use. Plug-compatible: register the
slave in the worker's I2C bus table and `_on_i2c_event` will route to it.

The picsimlab I2C protocol (ground truth in
docs/wiki/esp32-i2c-slave-simulation.md):
   op = event & 0xFF
   data = (event >> 8) & 0xFF        # only meaningful for WRITE

   0x00 START_RECV  : firmware called requestFrom
   0x01 START_SEND  : firmware called beginTransmission
   0x03 FINISH      : STOP or repeated-START
   0x04 NACK
   0x05 WRITE       : firmware sent `data` byte
   0x06 READ        : firmware reading; **return value IS the data byte**

Return-value convention:
   0  = ACK (success / device present)
   ≠0 = NACK (error)
   For READ: the byte to deliver to the firmware (not ACK/NACK).

What the chip sees is the header's contract (velxio-chip.h), the same one the
browser runtime keeps: EVERY START names the address to on_connect, a
repeated START included, so write-then-read tells the chip its read phase
began; on_stop once, at the FINISH. The adapter used to announce on_connect
once per transaction and re-arm it only on FINISH or NACK, so a repeated START
delivered straight after the write phase never reached the chip (PHASES.md
F7, the worker's second divergence). One thing this host cannot give the chip:
QEMU's bridge reports a repeated START as FINISH followed by START, so where
the guest never released the bus the chip still sees an on_stop in between.
The cross-host table names that on its row.

A chip that attached several addresses is one slave on the table with every
address (the table asks with `wants_address`), and each START goes to the
callbacks of the address it names.
"""
from __future__ import annotations

from app.services.wasm_chip_runtime import WasmChipRuntime


I2C_START_RECV = 0x00
I2C_START_SEND = 0x01
I2C_FINISH     = 0x03
I2C_NACK       = 0x04
I2C_WRITE      = 0x05
I2C_READ       = 0x06


class WasmChipI2CSlave:
    """Generic I2C slave whose protocol is implemented in a chip's WASM."""

    # The bus table hands this slave the address of every event, so a chip
    # with two addresses is served at both by one registration.
    wants_address = True

    def __init__(self, addr: int, runtime: WasmChipRuntime):
        self.addr = addr
        self.runtime = runtime

    @property
    def addresses(self) -> list[int]:
        """Every address the chip attached; what the worker registers."""
        addrs = list(self.runtime.i2c_addresses)
        return addrs if addrs else [self.addr]

    def handle_event(self, event: int, addr: int | None = None) -> int:
        op   = event & 0xFF
        data = (event >> 8) & 0xFF
        at   = self.addr if addr is None else int(addr)

        if op == I2C_START_SEND:
            # Master starting a write transaction, or turning the bus around
            # with a repeated START: the chip hears every one.
            self._connect(at, is_read=False)
            return 0  # ACK

        if op == I2C_START_RECV:
            self._connect(at, is_read=True)
            return 0  # ACK

        if op == I2C_WRITE:
            ack = self.runtime.call_i2c_callback("on_write", data)
            return 0 if ack else 1   # 0=ACK, 1=NACK

        if op == I2C_READ:
            # Return value is the byte itself, NOT an ACK/NACK marker.
            return self.runtime.call_i2c_callback("on_read") & 0xFF

        if op == I2C_FINISH:
            self.runtime.call_i2c_callback("on_stop")
            return 0

        if op == I2C_NACK:
            return 0

        # Unknown op: ACK silently to keep the bus alive.
        return 0

    def _connect(self, addr: int, *, is_read: bool) -> None:
        # on_connect's return is not the ACK, in this host or the browser's:
        # the address phase is ACKed by the chip being there.
        self.runtime.call_i2c_callback(
            "on_connect", addr, 1 if is_read else 0, address=addr,
        )
