"""
test_board_buses_f6_serial_output_raw.py: the bytes a QEMU guest transmits
reach the tab as they were on the pin (project/board-buses-2026-09, F6).

The lib manager chunks each UART's bytes for the serial monitor and decodes
the chunk as UTF-8. A part on the canvas wired to that UART needs the bytes,
not the text: a byte above 0x7f does not survive the decode (it becomes
U+FFFD), and a framed reply with a 0xAA sync word is exactly that. So every
`serial_output` event carries the chunk twice: `data`, the text the monitor
shows, and `b64`, the chunk itself, which the bridge hands to the board's
UART port on the bus fabric (Esp32Bridge.onUartTxBytes).

The read loop is driven with a fake worker process whose stdout is the JSON
lines the real worker prints, and the dispatch is captured.
"""
from __future__ import annotations

import base64
import io
import json
import unittest

from app.services import esp32_lib_manager as m


def feed_raw_all(buf: m._UartBuffer, data: bytes) -> list[bytes]:
    return [out for b in data if (out := buf.feed_raw(b)) is not None]


class TestUartBufferRaw(unittest.TestCase):
    def test_feed_raw_keeps_every_byte_of_the_chunk(self):
        self.assertEqual(feed_raw_all(m._UartBuffer(2), b'\xaa\x55\x0a'), [b'\xaa\x55\x0a'])

    def test_feed_still_gives_the_monitor_its_text(self):
        buf = m._UartBuffer(2)
        out = ''.join(t for b in b'\xaa\x55\x0a' if (t := buf.feed(b)) is not None)
        self.assertEqual(out, '�U\n')

    def test_flush_boundaries_are_the_same_for_both(self):
        """Newline, carriage return, a period, EOT and the size cap flush the
        raw chunk exactly where the text one flushed (issue #260)."""
        self.assertEqual(feed_raw_all(m._UartBuffer(0), b'OK\x04\x04>'), [b'OK\x04', b'\x04'])
        self.assertEqual(feed_raw_all(m._UartBuffer(0), b'a.b\r'), [b'a.', b'b\r'])
        self.assertEqual(feed_raw_all(m._UartBuffer(0, flush_size=4), b'abcdefgh'), [b'abcd', b'efgh'])


class _FakeProcess:
    def __init__(self, lines: list[bytes]) -> None:
        self.stdout = io.BytesIO(b''.join(lines))
        self.returncode = 0

    def poll(self) -> int:
        return self.returncode


class _FakeInstance:
    def __init__(self, lines: list[bytes]) -> None:
        self.process = _FakeProcess(lines)
        self.uart_bufs = {0: m._UartBuffer(0), 1: m._UartBuffer(1), 2: m._UartBuffer(2)}
        self.wifi_enabled = False
        self.running = False


def worker_lines(*events: dict) -> list[bytes]:
    return [json.dumps(e).encode() + b'\n' for e in events]


def uart_tx(uart: int, data: bytes) -> list[dict]:
    return [{'type': 'uart_tx', 'uart': uart, 'byte': b} for b in data]


class TestSerialOutputCarriesTheRawChunk(unittest.TestCase):
    def _events(self, *events: dict) -> list[tuple[str, dict]]:
        mgr = m.EspLibManager()
        got: list[tuple[str, dict]] = []
        mgr._dispatch = lambda inst, etype, data: got.append((etype, data))  # type: ignore[method-assign]
        mgr._thread_read_stdout(_FakeInstance(worker_lines(*events)), 'c1')
        return got

    def test_a_chunk_with_a_sync_word_travels_raw_beside_its_text(self):
        got = self._events(*uart_tx(2, b'\xaa\x55\x0a'))
        self.assertEqual(got, [('serial_output', {
            'data': '�U\n', 'uart': 2,
            'b64': base64.b64encode(b'\xaa\x55\x0a').decode('ascii'),
        })])

    def test_each_uart_keeps_its_own_chunk(self):
        got = self._events(*uart_tx(0, b'hi'), *uart_tx(2, b'OK\r'), *uart_tx(0, b'\n'))
        self.assertEqual([(e, d['uart'], base64.b64decode(d['b64'])) for e, d in got],
                         [('serial_output', 2, b'OK\r'), ('serial_output', 0, b'hi\n')])

    def test_the_text_and_the_bytes_agree_on_plain_ascii(self):
        got = self._events(*uart_tx(1, b'CO2=600\n'))
        (_, d), = got
        self.assertEqual(d['data'], 'CO2=600\n')
        self.assertEqual(base64.b64decode(d['b64']), b'CO2=600\n')
