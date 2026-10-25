// Conversations of the API connections (apiAgent.mjs), so a chat continues
// after a reload as a `claude -p --resume` does: one file per session under
// ~/.velxio-ai/sessions, in the provider's own message format, readable only
// by this user. The oldest go beyond MAX_SESSIONS.
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const MAX_SESSIONS = 200;
const ID = /^[0-9a-f-]{36}$/i;

export class ApiSessions {
  constructor(home) {
    this.dir = path.join(home, 'sessions');
  }

  #file(id) {
    if (!ID.test(id)) throw new Error('bad session id');
    return path.join(this.dir, `${id}.json`);
  }

  load(id) {
    try {
      const s = JSON.parse(readFileSync(this.#file(id), 'utf8'));
      return s && Array.isArray(s.items) ? s : null;
    } catch {
      return null;
    }
  }

  save(id, session) {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const file = this.#file(id);
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(session), { mode: 0o600 });
    renameSync(tmp, file);
    this.#prune();
  }

  #prune() {
    let names;
    try {
      names = readdirSync(this.dir).filter((n) => n.endsWith('.json'));
    } catch {
      return;
    }
    if (names.length <= MAX_SESSIONS) return;
    const byAge = names
      .map((n) => ({ n, t: statSync(path.join(this.dir, n)).mtimeMs }))
      .sort((a, b) => a.t - b.t);
    for (const { n } of byAge.slice(0, names.length - MAX_SESSIONS)) rmSync(path.join(this.dir, n), { force: true });
  }
}
