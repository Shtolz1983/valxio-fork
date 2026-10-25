/**
 * "Save project" into a chosen folder (utils/projectFolder.ts): which files a
 * project becomes, which existing ones a save would replace, and the writing,
 * against an in-memory stand-in of the browser's folder handles.
 */
import { describe, it, expect } from 'vitest';

import { findConflicts, planProjectFiles, targetLabel, writeProject, type FolderTarget } from '../utils/projectFolder';
import type { VlxPayload } from '../utils/vlxFile';

/** A folder as the File System Access API hands it over, kept in memory. */
class FakeDir {
  dirs = new Map<string, FakeDir>();
  files = new Map<string, string>();
  name: string;
  constructor(name: string) {
    this.name = name;
  }
  async getDirectoryHandle(name: string, opts?: { create?: boolean }) {
    let d = this.dirs.get(name);
    if (!d) {
      if (!opts?.create) throw new DOMException('not found', 'NotFoundError');
      d = new FakeDir(name);
      this.dirs.set(name, d);
    }
    return d;
  }
  async getFileHandle(name: string, opts?: { create?: boolean }) {
    if (!this.files.has(name)) {
      if (!opts?.create) throw new DOMException('not found', 'NotFoundError');
      this.files.set(name, '');
    }
    return {
      getFile: async () => ({ text: async () => this.files.get(name)! }),
      createWritable: async () => {
        let buf = '';
        return { write: async (s: string) => void (buf += s), close: async () => void this.files.set(name, buf) };
      },
    };
  }
}

const handle = (d: FakeDir) => d as unknown as FileSystemDirectoryHandle;

const payload = (sketch = 'void setup() {}\nvoid loop() {}\n'): VlxPayload => ({
  format: 'velxio',
  version: 1,
  exportedAt: new Date().toISOString(),
  name: 'Weather station',
  boards: [
    { id: 'arduino-uno', boardKind: 'arduino-uno', x: 0, y: 0, activeFileGroupId: 'g1' },
    { id: 'esp32', boardKind: 'esp32', x: 0, y: 0, activeFileGroupId: 'g2' },
  ],
  fileGroups: {
    g1: [
      { name: 'sketch.ino', content: sketch },
      { name: 'dht.h', content: '#pragma once\n' },
    ],
    g2: [{ name: 'sketch.ino', content: 'void setup() {}\n' }],
  },
  components: [],
  wires: [],
  activeBoardId: 'arduino-uno',
}) as unknown as VlxPayload;

describe('saving a project into a folder', () => {
  it('becomes the .vlx plus an Arduino sketch folder per board', () => {
    const files = planProjectFiles('Weather station', payload());
    expect(files.map((f) => f.path.join('/'))).toEqual([
      'Weather-station.vlx',
      'arduino-uno/arduino-uno.ino',
      'arduino-uno/dht.h',
      'esp32/esp32.ino',
    ]);
    expect(JSON.parse(files[0].content).boards).toHaveLength(2);
  });

  it('a new folder gets the project folder inside it and no warning', async () => {
    const picked = new FakeDir('Projects');
    const target: FolderTarget = { picked: handle(picked), sub: 'Weather-station' };
    const files = planProjectFiles('Weather station', payload());
    expect(await findConflicts(target, files)).toEqual([]);
    // Looking did not create anything.
    expect(picked.dirs.size).toBe(0);
    await writeProject(target, files);
    expect(targetLabel(target)).toBe('Projects/Weather-station');
    const proj = picked.dirs.get('Weather-station')!;
    expect([...proj.files.keys()]).toEqual(['Weather-station.vlx']);
    expect(proj.dirs.get('arduino-uno')!.files.get('arduino-uno.ino')).toBe('void setup() {}\nvoid loop() {}\n');
  });

  it('warns about files that would change, not about ones that hold the same text', async () => {
    const picked = new FakeDir('Weather-station');
    const target: FolderTarget = { picked: handle(picked), sub: null };
    await writeProject(target, planProjectFiles('Weather station', payload()));

    // Saved again unchanged (a later export time only): nothing to warn about.
    expect(await findConflicts(target, planProjectFiles('Weather station', payload()))).toEqual([]);

    // The sketch changed: the main .ino and the .vlx would be replaced.
    const changed = planProjectFiles('Weather station', payload('void setup() { Serial.begin(9600); }\nvoid loop() {}\n'));
    expect((await findConflicts(target, changed)).map((c) => c.path)).toEqual(['Weather-station.vlx', 'arduino-uno/arduino-uno.ino']);
  });
});
