/**
 * Pure planning for "Open sketch" (utils/importSketch.ts): which picked file
 * becomes sketch.ino, which #includes need which Library Manager library.
 * No store / i18n imports, so it is unit-tested on its own.
 */
import { searchLibraries } from '../services/libraryService';

/** Thrown when the picked files contain no .ino. */
export class NoInoFileError extends Error {
  constructor() {
    super('Pick at least one .ino file.');
    this.name = 'NoInoFileError';
  }
}

export const SKETCH_FILE_ACCEPT = '.ino,.h,.hpp,.cpp,.c';
const SKETCH_EXT_RE = /\.(ino|h|hpp|cpp|c)$/i;

export interface SketchSourceFile {
  name: string;
  content: string;
  /** Folder-relative path when picked from a directory (webkitRelativePath). */
  path?: string;
}

export interface SketchPlan {
  /** Files to load, main sketch first and renamed to sketch.ino. */
  files: { name: string; content: string }[];
  /** Original name of the file that became sketch.ino. */
  mainName: string;
  /** Headers from #include <…> / "…" that are not files of the sketch. */
  includes: string[];
  /** Picked files that are not sketch sources and were skipped. */
  skipped: string[];
}

const INCLUDE_RE = /^\s*#\s*include\s*[<"]([^>"]+)[>"]/gm;

/**
 * Choose the main .ino (the one named after its folder, else the one with
 * setup(), else the first), rename it sketch.ino and collect #includes.
 */
export function planSketchImport(sources: SketchSourceFile[]): SketchPlan {
  const skipped = sources.filter((f) => !SKETCH_EXT_RE.test(f.name)).map((f) => f.name);
  const files = sources.filter((f) => SKETCH_EXT_RE.test(f.name));
  const inos = files.filter((f) => /\.ino$/i.test(f.name));
  if (inos.length === 0) throw new NoInoFileError();

  const folderOf = (f: SketchSourceFile) => f.path?.split('/').slice(-2, -1)[0];
  const main =
    inos.find((f) => folderOf(f) && f.name.replace(/\.ino$/i, '') === folderOf(f)) ??
    inos.find((f) => /\bvoid\s+setup\s*\(/.test(f.content)) ??
    inos[0];

  const ordered = [main, ...files.filter((f) => f !== main)];
  const local = new Set(files.map((f) => f.name.toLowerCase()));
  const includes = new Set<string>();
  for (const f of ordered) {
    for (const m of f.content.matchAll(INCLUDE_RE)) {
      const header = m[1].trim();
      const base = header.split('/').pop()!.toLowerCase();
      if (!local.has(base)) includes.add(header);
    }
  }
  return {
    files: ordered.map((f) => ({ name: f === main ? 'sketch.ino' : f.name, content: f.content })),
    mainName: main.name,
    includes: [...includes],
    skipped,
  };
}

/** Headers the Arduino / ESP32 / RP2040 cores ship — nothing to install. */
const CORE_HEADERS = new Set(
  [
    'Arduino.h', 'Wire.h', 'SPI.h', 'EEPROM.h', 'SoftwareSerial.h', 'HardwareSerial.h', 'avr/io.h',
    'avr/interrupt.h', 'avr/pgmspace.h', 'avr/sleep.h', 'avr/wdt.h', 'util/delay.h', 'math.h',
    'stdint.h', 'stdlib.h', 'string.h', 'stdio.h', 'WiFi.h', 'WiFiClient.h', 'WiFiClientSecure.h',
    'WiFiUdp.h', 'WiFiMulti.h', 'WiFiAP.h', 'WebServer.h', 'HTTPClient.h', 'ESPmDNS.h', 'Preferences.h',
    'FS.h', 'SPIFFS.h', 'LittleFS.h', 'SD.h', 'SD_MMC.h', 'BluetoothSerial.h', 'BLEDevice.h',
    'BLEServer.h', 'BLEUtils.h', 'BLE2902.h', 'Update.h', 'ArduinoOTA.h', 'esp_sleep.h',
    'esp_wifi.h', 'esp_now.h', 'driver/adc.h', 'driver/gpio.h', 'freertos/FreeRTOS.h',
    'freertos/task.h', 'time.h', 'sys/time.h', 'Ticker.h', 'DNSServer.h', 'NetworkClient.h',
  ].map((h) => h.toLowerCase()),
);

/** Popular headers whose library name differs from what a search would guess. */
const KNOWN_LIBRARIES: Record<string, string> = {
  'dht.h': 'DHT sensor library',
  'adafruit_sensor.h': 'Adafruit Unified Sensor',
  'adafruit_gfx.h': 'Adafruit GFX Library',
  'adafruit_ssd1306.h': 'Adafruit SSD1306',
  'adafruit_sh110x.h': 'Adafruit SH110X',
  'adafruit_bmp280.h': 'Adafruit BMP280 Library',
  'adafruit_bme280.h': 'Adafruit BME280 Library',
  'adafruit_mpu6050.h': 'Adafruit MPU6050',
  'adafruit_neopixel.h': 'Adafruit NeoPixel',
  'adafruit_ili9341.h': 'Adafruit ILI9341',
  'adafruit_st7789.h': 'Adafruit ST7735 and ST7789 Library',
  'liquidcrystal_i2c.h': 'LiquidCrystal I2C',
  'liquidcrystal.h': 'LiquidCrystal',
  'servo.h': 'Servo',
  'esp32servo.h': 'ESP32Servo',
  'stepper.h': 'Stepper',
  'accelstepper.h': 'AccelStepper',
  'rtclib.h': 'RTClib',
  'tinygps++.h': 'TinyGPSPlus',
  'tinygpsplus.h': 'TinyGPSPlus',
  'irremote.h': 'IRremote',
  'irremote.hpp': 'IRremote',
  'hx711.h': 'HX711 Arduino Library',
  'onewire.h': 'OneWire',
  'dallastemperature.h': 'DallasTemperature',
  'pubsubclient.h': 'PubSubClient',
  'arduinojson.h': 'ArduinoJson',
  'fastled.h': 'FastLED',
  'keypad.h': 'Keypad',
  'u8g2lib.h': 'U8g2',
  'u8x8lib.h': 'U8g2',
  'tm1637display.h': 'TM1637',
  'mfrc522.h': 'MFRC522',
  'newping.h': 'NewPing',
  'tft_espi.h': 'TFT_eSPI',
  'mpu6050.h': 'MPU6050',
};

export interface LibraryResolution {
  libraries: string[];
  /** Headers no single library could be matched to. */
  unresolved: string[];
}

type SearchFn = (query: string) => Promise<Array<{ name: string; latest?: unknown }>>;

/**
 * Map #include headers to Library Manager names: core headers are skipped,
 * known ones come from the table, the rest from the library index — taken
 * only when exactly one library provides that header (no guessing).
 */
export async function resolveSketchLibraries(includes: string[], search: SearchFn = searchLibraries): Promise<LibraryResolution> {
  const libraries = new Set<string>();
  const unresolved: string[] = [];
  for (const header of includes) {
    const key = header.toLowerCase();
    if (CORE_HEADERS.has(key)) continue;
    const known = KNOWN_LIBRARIES[key];
    if (known) {
      libraries.add(known);
      continue;
    }
    const base = header.split('/').pop()!.replace(/\.(h|hpp)$/i, '');
    let providers: string[] = [];
    try {
      const results = await search(base);
      providers = results
        .filter((lib) => {
          const inc = (lib.latest as { provides_includes?: string[] } | undefined)?.provides_includes ?? [];
          return inc.some((i) => i.toLowerCase() === header.split('/').pop()!.toLowerCase());
        })
        .map((lib) => lib.name);
    } catch {
      providers = [];
    }
    if (providers.length === 1) libraries.add(providers[0]);
    else unresolved.push(header);
  }
  return { libraries: [...libraries], unresolved };
}

type DependencySearchFn = (query: string) => Promise<Array<{ name: string; latest?: unknown }>>;

/**
 * Add every library's dependencies (transitively) from the library index.
 * ESP32 builds only merge the libraries the board's manifest lists, so a
 * manifest of "Adafruit SSD1306" alone fails on Adafruit_GFX.h even though
 * arduino-cli installed GFX alongside it.
 */
export async function withLibraryDependencies(
  libraries: string[],
  search: DependencySearchFn = searchLibraries,
  maxDepth = 4,
): Promise<string[]> {
  const out: string[] = [];
  const seen = new Set<string>();
  let frontier = libraries;
  for (let depth = 0; depth <= maxDepth && frontier.length; depth++) {
    const next: string[] = [];
    for (const name of frontier) {
      const key = name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(name);
      if (depth === maxDepth) continue;
      try {
        const entry = (await search(name)).find((l) => l.name.toLowerCase() === key);
        const deps = (entry?.latest as { dependencies?: Array<{ name: string }> } | undefined)?.dependencies ?? [];
        for (const d of deps) if (d?.name) next.push(d.name);
      } catch {
        /* index unreachable: keep what we have */
      }
    }
    frontier = next;
  }
  return out;
}
