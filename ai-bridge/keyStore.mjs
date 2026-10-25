// API keys of the AI connections. On macOS they live in the login keychain
// (service "velxio-ai", account = connection id), handed to `security` on its
// stdin so a key never shows in a process list; elsewhere, or with
// VELXIO_AI_KEYS=file, in ~/.velxio-ai/api-keys.json readable only by this
// user. A key never leaves the bridge: the IDE sees only that one is set.
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const SERVICE = 'velxio-ai';
/** Printable ASCII: every provider's key format. Quotes and backslashes are refused, which keeps a `security -i` line safe. */
const KEY_FORMAT = /^[\x21-\x7e]{8,512}$/;

function run(args, input) {
  return new Promise((resolve) => {
    const child = spawn('security', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => resolve({ code: -1, out, err: e.message }));
    child.on('close', (code) => resolve({ code, out, err }));
    child.stdin.end(input ?? '');
  });
}

export class KeyStore {
  /** @param {{ home: string, backend?: 'keychain' | 'file' }} opts */
  constructor({ home, backend } = {}) {
    this.home = home;
    this.backend = backend ?? (process.platform === 'darwin' && process.env.VELXIO_AI_KEYS !== 'file' ? 'keychain' : 'file');
    this.file = path.join(home, 'api-keys.json');
  }

  static validKey(key) {
    return typeof key === 'string' && KEY_FORMAT.test(key) && !/["'\\]/.test(key);
  }

  #readFile() {
    try {
      return JSON.parse(readFileSync(this.file, 'utf8'));
    } catch {
      return {};
    }
  }

  #writeFile(all) {
    mkdirSync(this.home, { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(all), { mode: 0o600 });
    renameSync(tmp, this.file);
  }

  async set(id, key) {
    if (!KeyStore.validKey(key)) throw new Error('that does not look like an API key');
    if (this.backend === 'file') {
      this.#writeFile({ ...this.#readFile(), [id]: key });
      return;
    }
    const r = await run(['-i'], `add-generic-password -U -s ${SERVICE} -a ${id} -w "${key}"\n`);
    if (r.code !== 0 || /error/i.test(r.err)) throw new Error(`the keychain refused the key: ${r.err.trim() || `exit ${r.code}`}`);
  }

  /** The key, or null when none is set. */
  async get(id) {
    if (this.backend === 'file') return this.#readFile()[id] ?? null;
    const r = await run(['find-generic-password', '-s', SERVICE, '-a', id, '-w']);
    return r.code === 0 ? r.out.replace(/\n$/, '') || null : null;
  }

  async delete(id) {
    if (this.backend === 'file') {
      const all = this.#readFile();
      delete all[id];
      this.#writeFile(all);
      return;
    }
    await run(['delete-generic-password', '-s', SERVICE, '-a', id]);
  }
}
