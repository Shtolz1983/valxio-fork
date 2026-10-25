"""Parts-catalog chips that keep time, on the ESP32 worker
(app/services/catalog_i2c_complex.py): VL53L0X and MAX30102.

Each script below is the traffic of the card's library (recorded from the
card example on the Uno against the tab's model, polling loops folded into
`~` tokens), replayed through catalog_slave() and the worker's bus events.
The expected bytes were produced by the tab's TypeScript models
(frontend/src/partsCatalog/models/i2cComplex.ts) running the same script:
with a guest clock that moves DT per transaction, and with none.

Script tokens:
  RR?N        write register RR, then read N bytes
  RR=AA.BB    write AA, BB, ... from register RR
  RR~MM       poll register RR until a value & MM; yields (polls, value)
  drain:N     SparkFun check(): read FIFO_RD, FIFO_WR, then N bytes per sample
  +US         US microseconds pass
  @key=V      the panel sets value `key`
"""

import re

from app.services.catalog_i2c_models import (
    I2C_FINISH,
    I2C_READ,
    I2C_START_RECV,
    I2C_START_SEND,
    I2C_WRITE,
    MODELS,
    catalog_slave,
)

DT = 60_000  # ns per bus transaction

# Pololu VL53L0X: init(), startContinuous(), four readRangeContinuousMillimeters()
# 100 ms apart with the panel moving to 1234 mm and then out of range.
VL53L0X_SCRIPT = """
c0?1 89?1 89=01 88=00 80=01 ff=01 00=00 91?1 00=01 ff=00 80=00 60?1 60=12 44=00.20 01=ff
80=01 ff=01 00=00 ff=06 83?1 83=04 ff=07 81=01 80=01 94=6b 83=00 83~ff 83=01 92?1 81=00 ff=06
83?1 83=00 ff=01 00=01 ff=00 80=00 b0?6 ff=01 4f=00 4e=2c ff=00 b6=b4 b0=00.f0.0f.00.00.00
ff=01 00=00 ff=00 09=00 10=00 11=00 24=01 25=ff 75=00 ff=01 4e=2c 48=00 30=20 ff=00 30=09
54=00 31=04 32=03 40=83 46=25 60=00 27=00 50=06 51=00 52=96 56=08 57=30 61=00 62=00 64=00
65=00 66=a0 ff=01 22=32 47=14 49=ff 4a=00 ff=00 7a=0a 7b=00 78=21 ff=01 23=34 42=00 44=ff
45=26 46=05 40=40 0e=06 20=1a 43=40 ff=00 34=03 35=44 ff=01 31=04 4b=09 4c=05 4d=04 ff=00
44=00 45=20 47=08 48=28 67=00 70=04 71=01 72=fe 76=00 77=00 ff=01 0d=01 ff=00 80=01 01=f8
ff=01 8e=01 00=01 ff=00 80=00 0a=04 84?1 84=01 0b=01 01?1 50?1 46?1 51?2 70?1 71?2 01=e8
01?1 50?1 46?1 51?2 70?1 71?2 71=02.90 01=01 00=41 13~07 0b=01 00=00 01=02 00=01 13~07 0b=01
00=00 01=e8 80=01 ff=01 00=00 91=3c 00=01 ff=00 80=00
00=02 13~07 1e?2 0b=01
+100000 13~07 1e?2 0b=01
@distance=1234 +100000 13~07 1e?2 0b=01
@distance=2200 +100000 13~07 1e?2 0b=01
"""

# SparkFun MAX3010x: begin(), setup() (multi-LED, 3 slots, 4x averaging at
# 400 Hz), setPulseAmplitudeRed(0x0A), then getIR()'s check() now and then,
# the panel's bpm and finger moving, and a die temperature read.
MAX30102_SCRIPT = """
ff?1 fe?1 09?1 09=40 09?1 08?1 08=40 08?1 08=50 09?1 09=07 0a?1 0a=20 0a?1 0a=2c 0a?1 0a=2f
0c=1f 0d=1f 0e=1f 10=1f 11?1 11=01 11?1 11=21 12?1 12=03 04=00 05=00 06=00 0c=0a
drain:9 +30000 drain:9 drain:9 +45000 drain:9
@bpm=120 +50000 drain:9
@finger=0 +20000 drain:9
00?1 +400000 00?1 drain:9 05?1
21=01 01?1 1f?1 20?1 01?1
"""

SCRIPTS = {
    'vl53l0x': {'model': 'vl53l0x', 'addr': 0x29, 'values': {'distance': 500}, 'script': VL53L0X_SCRIPT},
    'max30102': {'model': 'max30102', 'addr': 0x57, 'values': {'bpm': 72, 'finger': 1}, 'script': MAX30102_SCRIPT},
}

TS_BYTES = {
    'vl53l0x clock': [
        238, 0, 60, 0, 0, 1, 16, 136, 4, 255, 255, 255, 255, 255, 255, 17, 248, 6, 37, 0, 150, 4, 1,
        254, 232, 6, 37, 0, 150, 4, 1, 254, 9, 4, 9, 4, 282, 4, 1, 244, 1, 4, 1, 244, 1, 4, 4, 210,
        1, 4, 31, 254,
    ],
    'vl53l0x none': [
        238, 0, 60, 0, 0, 1, 16, 136, 4, 255, 255, 255, 255, 255, 255, 17, 248, 6, 37, 0, 150, 4, 1,
        254, 232, 6, 37, 0, 150, 4, 1, 254, 1, 4, 1, 4, 1, 4, 1, 244, 1, 4, 1, 244, 1, 4, 4, 210, 1,
        4, 31, 254,
    ],
    'max30102 clock': [
        21, 3, 0, 0, 0, 64, 0, 0, 32, 44, 0, 1, 0, 0, 0, 0, 3, 0, 110, 247, 1, 134, 229, 0, 1, 144,
        0, 110, 251, 1, 134, 246, 0, 1, 144, 0, 111, 0, 1, 135, 4, 0, 1, 144, 3, 3, 3, 7, 0, 111, 3,
        1, 135, 17, 0, 1, 144, 0, 111, 6, 1, 135, 27, 0, 1, 144, 0, 111, 8, 1, 135, 35, 0, 1, 144,
        0, 111, 10, 1, 135, 41, 0, 1, 144, 7, 12, 0, 111, 11, 1, 135, 46, 0, 1, 144, 0, 111, 12, 1,
        135, 47, 0, 1, 144, 0, 111, 11, 1, 135, 45, 0, 1, 144, 0, 111, 10, 1, 135, 41, 0, 1, 144, 0,
        111, 8, 1, 135, 35, 0, 1, 144, 12, 14, 0, 1, 34, 0, 4, 176, 0, 0, 200, 0, 1, 34, 0, 4, 176,
        0, 0, 200, 65, 192, 22, 22, 8, 2, 30, 0, 0,
    ],
    'max30102 none': [
        21, 3, 0, 0, 0, 64, 0, 0, 32, 44, 0, 1, 0, 0, 1, 0, 110, 246, 1, 134, 226, 0, 1, 144, 1, 2,
        0, 110, 251, 1, 134, 243, 0, 1, 144, 2, 3, 0, 110, 255, 1, 135, 2, 0, 1, 144, 3, 4, 0, 111,
        2, 1, 135, 14, 0, 1, 144, 4, 5, 0, 111, 7, 1, 135, 31, 0, 1, 144, 5, 6, 0, 1, 34, 0, 4, 176,
        0, 0, 200, 65, 0, 6, 7, 0, 1, 34, 0, 4, 176, 0, 0, 200, 0, 2, 30, 0, 0,
    ],
}


class FakeClock:
    def __init__(self):
        self.ns = 0

    def __call__(self):
        return self.ns


def _write(slave, clock, data):
    slave.handle_event(I2C_START_SEND)
    for b in data:
        slave.handle_event((b << 8) | I2C_WRITE)
    slave.handle_event(I2C_FINISH)
    clock.ns += DT


def _read(slave, clock, n):
    slave.handle_event(I2C_START_RECV)
    out = [slave.handle_event(I2C_READ) for _ in range(n)]
    slave.handle_event(I2C_FINISH)
    clock.ns += DT
    return out


def run_script(name: str, clocked: bool) -> list:
    """The script on a fresh slave; with `clocked` the guest clock moves DT
    per transaction, else the model has no clock."""
    spec = SCRIPTS[name]
    clock = FakeClock()
    record = {'sensor_type': 'catalog-i2c', 'model': spec['model'], 'addr': spec['addr'], **spec['values']}
    slave = catalog_slave(record, now_ns=clock if clocked else None)
    out = []
    for tok in spec['script'].split():
        if m := re.fullmatch(r'@(\w+)=([\d.]+)', tok):
            slave.update(**{m[1]: float(m[2])})
        elif m := re.fullmatch(r'\+(\d+)', tok):
            clock.ns += int(m[1]) * 1000
        elif m := re.fullmatch(r'([0-9a-f]{2})\?(\d+)', tok):
            _write(slave, clock, [int(m[1], 16)])
            out += _read(slave, clock, int(m[2]))
        elif m := re.fullmatch(r'([0-9a-f]{2})=([0-9a-f.]*)', tok):
            _write(slave, clock, [int(m[1], 16)] + [int(h, 16) for h in m[2].split('.') if h])
        elif m := re.fullmatch(r'([0-9a-f]{2})~([0-9a-f]{2})', tok):
            count = 0
            while True:
                _write(slave, clock, [int(m[1], 16)])
                v = _read(slave, clock, 1)[0]
                count += 1
                if v & int(m[2], 16) or count >= 5000:
                    break
            out += [count, v]
        elif m := re.fullmatch(r'drain:(\d+)', tok):
            _write(slave, clock, [0x06])
            rd = _read(slave, clock, 1)[0]
            _write(slave, clock, [0x04])
            wr = _read(slave, clock, 1)[0]
            out += [rd, wr]
            avail = (wr - rd) & 31
            if avail:
                _write(slave, clock, [0x07])
                out += _read(slave, clock, avail * int(m[1]))
        else:
            raise ValueError(tok)
    return out


def test_the_aggregator_loads_both_models_as_clocked():
    for name in ('vl53l0x', 'max30102'):
        assert getattr(MODELS[name], 'uses_clock', False)


def test_vl53l0x_answers_pololu_exactly_as_the_tab_model():
    assert run_script('vl53l0x', True) == TS_BYTES['vl53l0x clock']
    assert run_script('vl53l0x', False) == TS_BYTES['vl53l0x none']


def test_vl53l0x_measures_on_the_guest_clock():
    out = run_script('vl53l0x', True)
    # The four readings: (polls, status), range high, range low.
    readings = [out[i:i + 4] for i in range(len(out) - 16, len(out), 4)]
    mm = [(hi << 8) | lo for _, _, hi, lo in readings]
    assert mm == [500, 500, 1234, 8190]
    # The first waits a whole timing budget (startContinuous() after
    # setMeasurementTimingBudget(33000): 33.823 ms, 2 transactions per poll);
    # the later ones find it done after the sketch's 100 ms.
    polls = readings[0][0]
    assert abs(polls * 2 * DT - 33_823_000) <= 2 * DT
    assert [r[0] for r in readings[1:]] == [1, 1, 1]


def test_vl53l0x_without_a_clock_is_ready_at_the_first_poll():
    out = run_script('vl53l0x', False)
    readings = [out[i:i + 4] for i in range(len(out) - 16, len(out), 4)]
    assert [r[0] for r in readings] == [1, 1, 1, 1]
    assert [(hi << 8) | lo for _, _, hi, lo in readings] == [500, 500, 1234, 8190]


def test_max30102_answers_sparkfun_exactly_as_the_tab_model():
    assert run_script('max30102', True) == TS_BYTES['max30102 clock']
    assert run_script('max30102', False) == TS_BYTES['max30102 none']


def test_max30102_fills_the_fifo_at_100_samples_per_second():
    out = run_script('max30102', True)
    # begin()/setup() reads: part id, revision, then 11 read-modify-writes.
    assert out[:2] == [0x15, 0x03]
    rest = out[13:]
    rd, wr = rest[0], rest[1]
    assert (rd, wr) == (0, 0)  # nothing sampled yet
    rd, wr = rest[2], rest[3]
    samples = (wr - rd) & 31
    assert samples == 3  # 30 ms after the start, 10 ms per sample
    ir = ((rest[4 + 3] << 16) | (rest[4 + 4] << 8) | rest[4 + 5]) & 0x3FFFF
    red = ((rest[4] << 16) | (rest[5] << 8) | rest[6]) & 0x3FFFF
    assert 99_000 < ir < 101_000
    # setPulseAmplitudeRed(0x0A): the red channel at 10/31 of its DC.
    assert 27_000 < red < 29_000
