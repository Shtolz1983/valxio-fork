import { describe, it, expect } from 'vitest';
import {
  NoInoFileError,
  missingHeadersFromLog,
  planSketchImport,
  resolveSketchLibraries,
  withLibraryDependencies,
} from '../utils/sketchPlan';

describe('missingHeadersFromLog', () => {
  it('reads gcc and backend missing-header errors, once each', () => {
    const log = [
      '/tmp/x/sketch/sketch.ino:31:10: fatal error: LedControl.h: No such file or directory',
      ' #include <LedControl.h>',
      'compilation terminated.',
      '<DHT.h>: none of the libraries in this project provides it.',
      '/tmp/y/Adafruit_SSD1306.h:42:10: fatal error: Adafruit_GFX.h: No such file or directory',
      '/tmp/x/sketch/sketch.ino:31:10: fatal error: LedControl.h: No such file or directory',
    ].join('\n');
    expect(missingHeadersFromLog(log)).toEqual(['LedControl.h', 'Adafruit_GFX.h', 'DHT.h']);
  });

  it('ignores ordinary compile errors', () => {
    expect(missingHeadersFromLog("sketch.ino:3:5: error: 'foo' was not declared in this scope")).toEqual([]);
  });
});

describe('withLibraryDependencies', () => {
  const index = async (q: string) =>
    [
      { name: 'Adafruit SSD1306', latest: { dependencies: [{ name: 'Adafruit GFX Library' }] } },
      { name: 'Adafruit GFX Library', latest: { dependencies: [{ name: 'Adafruit BusIO' }] } },
      { name: 'Adafruit BusIO', latest: { dependencies: [] } },
      { name: 'DHT sensor library', latest: { dependencies: [{ name: 'Adafruit Unified Sensor' }] } },
    ].filter((l) => l.name.toLowerCase().includes(q.toLowerCase()));

  it('adds dependencies transitively, once each, requested libraries first', async () => {
    expect(await withLibraryDependencies(['Adafruit SSD1306', 'DHT sensor library', 'adafruit gfx library'], index)).toEqual([
      'Adafruit SSD1306',
      'DHT sensor library',
      'adafruit gfx library',
      'Adafruit Unified Sensor',
      'Adafruit BusIO',
    ]);
  });

  it('keeps the list as is when the index is unreachable', async () => {
    const offline = async () => {
      throw new Error('offline');
    };
    expect(await withLibraryDependencies(['Servo'], offline)).toEqual(['Servo']);
  });
});

describe('planSketchImport', () => {
  it('turns a lone .ino into sketch.ino and collects its includes', () => {
    const plan = planSketchImport([
      { name: 'weather.ino', content: '#include <DHT.h>\n#include "Wire.h"\nvoid setup(){}\nvoid loop(){}' },
    ]);
    expect(plan.files).toEqual([{ name: 'sketch.ino', content: expect.stringContaining('DHT') }]);
    expect(plan.mainName).toBe('weather.ino');
    expect(plan.includes).toEqual(['DHT.h', 'Wire.h']);
  });

  it('keeps the sketch tabs, puts the main .ino first and drops includes of its own headers', () => {
    const plan = planSketchImport([
      { name: 'config.h', content: '#define PIN 4' },
      { name: 'helpers.ino', content: 'void blink(){}' },
      { name: 'robot.ino', content: '#include "config.h"\n#include <Servo.h>\nvoid setup(){}' },
      { name: 'notes.txt', content: 'todo' },
    ]);
    expect(plan.mainName).toBe('robot.ino');
    expect(plan.files.map((f) => f.name)).toEqual(['sketch.ino', 'config.h', 'helpers.ino']);
    expect(plan.includes).toEqual(['Servo.h']);
    expect(plan.skipped).toEqual(['notes.txt']);
  });

  it('prefers the .ino named after its folder, as the Arduino IDE does', () => {
    const plan = planSketchImport([
      { name: 'other.ino', content: 'void setup(){}', path: 'robot/other.ino' },
      { name: 'robot.ino', content: 'void loop(){}', path: 'robot/robot.ino' },
    ]);
    expect(plan.mainName).toBe('robot.ino');
  });

  it('refuses a pick without any .ino', () => {
    expect(() => planSketchImport([{ name: 'lib.h', content: '' }])).toThrow(NoInoFileError);
  });
});

describe('resolveSketchLibraries', () => {
  const index = async (q: string) =>
    ({
      Bounce2: [{ name: 'Bounce2', latest: { provides_includes: ['Bounce2.h'] } }],
      Ambiguous: [
        { name: 'Lib A', latest: { provides_includes: ['Ambiguous.h'] } },
        { name: 'Lib B', latest: { provides_includes: ['Ambiguous.h'] } },
      ],
    })[q] ?? [];

  it('skips core headers, uses the known table, and asks the index for the rest', async () => {
    const res = await resolveSketchLibraries(['Wire.h', 'WiFi.h', 'DHT.h', 'Adafruit_SSD1306.h', 'Bounce2.h'], index);
    expect(res.libraries).toEqual(['DHT sensor library', 'Adafruit SSD1306', 'Bounce2']);
    expect(res.unresolved).toEqual([]);
  });

  it('does not guess when several libraries provide a header or none does', async () => {
    const res = await resolveSketchLibraries(['Ambiguous.h', 'Nowhere.h'], index);
    expect(res.libraries).toEqual([]);
    expect(res.unresolved).toEqual(['Ambiguous.h', 'Nowhere.h']);
  });

  it('survives a failing index search', async () => {
    const res = await resolveSketchLibraries(['Bounce2.h'], async () => {
      throw new Error('offline');
    });
    expect(res.unresolved).toEqual(['Bounce2.h']);
  });
});
