"""
The QEMU worker's custom-chip framebuffer (velxio issue #338).

A custom display chip on an ESP32 decoded its SPI perfectly and stayed black:
vx_framebuffer_init / vx_buffer_write were stubs in the worker's WasmChipRuntime,
so no chip could paint on the QEMU path whatever its code did. The runtime now
keeps the RGBA buffer, tracks the byte span the chip touched, and ships those
rows as ONE zlib-deflated `chip_framebuffer` event per flush — the worker's
flush thread calls flush_framebuffer() on a 50 ms cadence, never per write.

The chip under test is a WAT module compiled in-process: it needs nothing but
the three framebuffer imports and the shared memory, which is exactly the
contract velxio-chip.h gives a display chip.
"""
from __future__ import annotations

import base64
import struct
import zlib

import pytest

wasmtime = pytest.importorskip("wasmtime")

from app.services.wasm_chip_runtime import WasmChipRuntime  # noqa: E402

# chip_setup: acquire the framebuffer, keep the handle and the dims at 0..12,
# then write a 4-byte pixel at the byte offset in $off (an exported global the
# test drives), reading the pixel bytes from memory at 16.
# paint(offset): buffer_write(handle, offset, mem[16..20), 4)
# readback(offset): buffer_read(handle, offset, mem[32..36), 4)
CHIP_WAT = r"""
(module
  (import "env" "memory" (memory 1))
  (import "env" "vx_framebuffer_init" (func $fb_init (param i32 i32) (result i32)))
  (import "env" "vx_buffer_write" (func $buf_write (param i32 i32 i32 i32)))
  (import "env" "vx_buffer_read" (func $buf_read (param i32 i32 i32 i32)))
  (global $handle (mut i32) (i32.const -1))
  (func (export "chip_setup")
    (global.set $handle (call $fb_init (i32.const 0) (i32.const 4)))
    (i32.store (i32.const 8) (global.get $handle)))
  (func (export "paint") (param $off i32)
    (call $buf_write (global.get $handle) (local.get $off) (i32.const 16) (i32.const 4)))
  (func (export "readback") (param $off i32)
    (call $buf_read (global.get $handle) (local.get $off) (i32.const 32) (i32.const 4)))
)
"""


def make_chip(display=None, component_id="chip-1"):
    events: list[dict] = []
    rt = WasmChipRuntime(
        wasmtime.wat2wasm(CHIP_WAT),
        attrs={},
        emit=events.append,
        display=display,
        component_id=component_id,
    )
    rt.run_chip_setup()
    return rt, events


def mem_u32(rt: WasmChipRuntime, addr: int) -> int:
    return struct.unpack("<I", rt._read_bytes(addr, 4))[0]


def paint(rt: WasmChipRuntime, offset: int, rgba: bytes) -> None:
    rt._write_bytes(16, rgba)
    rt._exports["paint"](rt._store, offset)


def decode(event: dict) -> bytes:
    return zlib.decompress(base64.b64decode(event["rows_zlib_b64"]))


def test_init_hands_the_chip_the_declared_size():
    rt, _ = make_chip(display={"width": 480, "height": 320})
    assert (mem_u32(rt, 0), mem_u32(rt, 4)) == (480, 320)
    assert mem_u32(rt, 8) == 0  # a real handle, not the old -1 stub
    assert rt.has_framebuffer()


def test_default_size_matches_the_browser_runtime():
    # ChipRuntime.ts falls back to 128x64 for a chip.json with no `display`.
    rt, _ = make_chip(display=None)
    assert (mem_u32(rt, 0), mem_u32(rt, 4)) == (128, 64)


def test_first_flush_is_the_whole_buffer_then_only_touched_rows():
    rt, events = make_chip(display={"width": 8, "height": 4}, component_id="tft")
    assert rt.flush_framebuffer() is True
    first = events[-1]
    assert first["type"] == "chip_framebuffer"
    assert first["component_id"] == "tft"
    assert (first["width"], first["height"], first["y0"], first["y1"]) == (8, 4, 0, 3)
    assert decode(first) == bytes(8 * 4 * 4)  # born black

    assert rt.flush_framebuffer() is False  # nothing touched: no event, no bytes
    n = len(events)

    # Pixel (x=2, y=2): row 2 only goes out, with the pixel where the chip put it.
    paint(rt, (2 * 8 + 2) * 4, b"\xff\x80\x40\xff")
    assert rt.flush_framebuffer() is True
    ev = events[-1]
    assert len(events) == n + 1
    assert (ev["y0"], ev["y1"]) == (2, 2)
    row = decode(ev)
    assert len(row) == 8 * 4
    assert row[8:12] == b"\xff\x80\x40\xff"
    assert row[:8] == bytes(8)


def test_a_window_spanning_rows_ships_the_span_once():
    rt, events = make_chip(display={"width": 4, "height": 6})
    rt.flush_framebuffer()
    paint(rt, (1 * 4 + 3) * 4, b"\x01\x02\x03\xff")  # row 1, last pixel
    paint(rt, (4 * 4 + 0) * 4, b"\x04\x05\x06\xff")  # row 4, first pixel
    rt.flush_framebuffer()
    ev = events[-1]
    assert (ev["y0"], ev["y1"]) == (1, 4)
    rows = decode(ev)
    assert len(rows) == 4 * 4 * 4
    assert rows[12:16] == b"\x01\x02\x03\xff"
    assert rows[3 * 16:3 * 16 + 4] == b"\x04\x05\x06\xff"


def test_writes_past_the_buffer_are_clipped_not_fatal():
    rt, events = make_chip(display={"width": 2, "height": 2})
    rt.flush_framebuffer()
    paint(rt, 14, b"\xaa\xbb\xcc\xdd")  # 2 bytes in, 2 bytes out
    rt.flush_framebuffer()
    ev = events[-1]
    assert (ev["y0"], ev["y1"]) == (1, 1)  # byte 14 is in row 1 of a 2x2 image
    rows = decode(ev)
    assert rows[6:8] == b"\xaa\xbb"  # offset 14 - one 8-byte row
    paint(rt, 10_000, b"\x01\x02\x03\x04")  # entirely outside: ignored
    assert rt.flush_framebuffer() is False


def test_buffer_read_returns_what_was_written():
    rt, _ = make_chip(display={"width": 4, "height": 4})
    paint(rt, 20, b"\x11\x22\x33\x44")
    rt._exports["readback"](rt._store, 20)
    assert rt._read_bytes(32, 4) == b"\x11\x22\x33\x44"
