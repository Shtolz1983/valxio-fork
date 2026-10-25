// The AI connections of this computer: which agents the IDE can talk to and
// which one answers the chat and writes parts cards.
//
// Kept in ~/.velxio-ai/connections.json (VELXIO_AI_HOME overrides the folder),
// readable only by this user. It holds no secrets: an account is a Claude
// Code config folder signed in by its own `claude auth login` (as Orca's
// `orca account add` does), and API keys live in the system keychain
// (keyStore.mjs). API kinds (`api: true`) run through apiAgent.mjs; their
// models come from the provider (`models` here is empty, the IDE asks).
//
// With no file yet there is one connection, the Claude Code login the bridge
// itself runs under ("system"), so a fresh install behaves as before.
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync, existsSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

/** What each kind of connection is and the models it offers. */
export const KINDS = {
  'claude-code': {
    label: 'Claude Code',
    // The aliases follow Claude Code's newest model of the family; an exact
    // id pins one version. Which ones an account may use is the account's.
    models: [
      { id: 'opus', label: 'Opus (latest)' },
      { id: 'sonnet', label: 'Sonnet (latest)' },
      { id: 'haiku', label: 'Haiku (latest)' },
      { id: 'claude-fable-5-1', label: 'Fable 5.1' },
      { id: 'claude-opus-5-5', label: 'Opus 5.5' },
      { id: 'claude-opus-5', label: 'Opus 5' },
      { id: 'claude-opus-4-8', label: 'Opus 4.8' },
      { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5' },
      { id: 'claude-sonnet-5', label: 'Sonnet 5' },
      { id: 'claude-haiku-5-5', label: 'Haiku 5.5' },
    ],
    defaultModel: 'sonnet',
  },
  anthropic: { label: 'Anthropic API', api: true, key: 'required', models: [], defaultModel: 'claude-opus-5-5' },
  openai: { label: 'OpenAI API', api: true, key: 'required', models: [] },
  openrouter: { label: 'OpenRouter', api: true, key: 'required', models: [], baseUrl: 'https://openrouter.ai/api/v1' },
  'openai-compatible': { label: 'OpenAI-compatible server', api: true, key: 'optional', models: [], needsBaseUrl: true },
  ollama: { label: 'Ollama (this computer)', api: true, key: 'none', models: [], baseUrl: 'http://127.0.0.1:11434/v1' },
};

const MODEL_ID = /^[\w.:/@+-]{1,200}$/;

/** A model id the connection may use: one of its list, or any for an API kind (the provider decides). */
function validModel(kind, model) {
  const meta = KINDS[kind];
  return meta.api ? typeof model === 'string' && MODEL_ID.test(model) : meta.models.some((m) => m.id === model);
}

/** The server an API connection talks to, as typed or its kind's fixed one. */
export function connectionBaseUrl(conn) {
  return conn.baseUrl ?? KINDS[conn.kind]?.baseUrl ?? null;
}

function cleanBaseUrl(url) {
  if (typeof url !== 'string' || !url.trim()) return null;
  let u;
  try {
    u = new URL(url.trim());
  } catch {
    throw new Error(`not a URL: ${url}`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('the server address must start with http:// or https://');
  return u.toString().replace(/\/$/, '');
}

export const ROLES = ['chat', 'cards'];

export function defaultHome() {
  return process.env.VELXIO_AI_HOME ?? path.join(os.homedir(), '.velxio-ai');
}

const LABEL_MAX = 40;

function cleanLabel(label, fallback) {
  const s = typeof label === 'string' ? label.trim().slice(0, LABEL_MAX) : '';
  return s || fallback;
}

export class ConnectionStore {
  /**
   * @param {{ home?: string, systemModel?: string }} [opts]
   *   systemModel: the model of the built-in system connection on first run
   *   (the bridge's CLAUDE_MODEL).
   */
  constructor({ home = defaultHome(), systemModel } = {}) {
    this.home = home;
    this.file = path.join(home, 'connections.json');
    this.systemModel = KINDS['claude-code'].models.some((m) => m.id === systemModel) ? systemModel : KINDS['claude-code'].defaultModel;
    this.state = this.#load();
  }

  #fresh() {
    return {
      connections: [{ id: 'system', kind: 'claude-code', label: 'Claude Code', model: this.systemModel, configDir: null, managed: false }],
      selected: { chat: 'system', cards: 'system' },
    };
  }

  #load() {
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8'));
      const connections = (Array.isArray(raw.connections) ? raw.connections : []).filter(
        (c) => c && typeof c.id === 'string' && KINDS[c.kind],
      );
      if (!connections.length) return this.#fresh();
      const selected = {};
      for (const role of ROLES) {
        const id = raw.selected?.[role];
        selected[role] = connections.some((c) => c.id === id) ? id : connections[0].id;
      }
      return { connections, selected };
    } catch {
      return this.#fresh();
    }
  }

  #save() {
    mkdirSync(this.home, { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state, null, 2), { mode: 0o600 });
    renameSync(tmp, this.file);
  }

  list() {
    return this.state.connections.map((c) => ({ ...c }));
  }

  get(id) {
    const c = this.state.connections.find((x) => x.id === id);
    return c ? { ...c } : null;
  }

  /** The connection a role uses: chat or cards. */
  selected(role) {
    return this.get(this.state.selected[role]) ?? this.list()[0];
  }

  selection() {
    return { ...this.state.selected };
  }

  /** Folder for a new account the bridge signs in itself. */
  managedDir(id) {
    return path.join(this.home, 'claude', id);
  }

  /**
   * A new connection. Claude Code: `configDir` an existing signed-in folder
   * (kept, never deleted), or none: a fresh folder under the home, for
   * `claude auth login`.
   */
  add({ kind, label, model, configDir, baseUrl }) {
    const meta = KINDS[kind];
    if (!meta) throw new Error(`unknown connection kind "${kind}"`);
    if (meta.api && !validModel(kind, model)) throw new Error('pick a model');
    const url = meta.api ? cleanBaseUrl(baseUrl) : null;
    if (meta.needsBaseUrl && !url) throw new Error('the server address is missing');
    const id = randomUUID();
    let dir = null;
    let managed = false;
    if (kind === 'claude-code') {
      if (typeof configDir === 'string' && configDir.trim()) {
        dir = path.resolve(configDir.trim().replace(/^~(?=$|\/)/, os.homedir()));
        if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new Error(`no folder ${dir}`);
      } else {
        dir = this.managedDir(id);
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        managed = true;
      }
    }
    const conn = {
      id,
      kind,
      label: cleanLabel(label, meta.label),
      model: validModel(kind, model) ? model : meta.defaultModel,
      configDir: dir,
      managed,
      ...(url ? { baseUrl: url } : {}),
    };
    this.state.connections.push(conn);
    this.#save();
    return { ...conn };
  }

  /** Change the label or the model. */
  update(id, { label, model } = {}) {
    const c = this.state.connections.find((x) => x.id === id);
    if (!c) throw new Error('no such connection');
    if (label !== undefined) c.label = cleanLabel(label, c.label);
    if (model !== undefined) {
      if (!validModel(c.kind, model)) throw new Error(`unknown model "${model}"`);
      c.model = model;
    }
    this.#save();
    return { ...c };
  }

  /** Remove a connection; a folder the bridge created for it goes too. */
  remove(id) {
    const i = this.state.connections.findIndex((x) => x.id === id);
    if (i < 0) return;
    if (this.state.connections.length === 1) throw new Error('the last connection cannot be removed');
    const [c] = this.state.connections.splice(i, 1);
    for (const role of ROLES) {
      if (this.state.selected[role] === id) this.state.selected[role] = this.state.connections[0].id;
    }
    this.#save();
    if (c.managed && c.configDir && c.configDir.startsWith(path.join(this.home, 'claude') + path.sep)) {
      rmSync(c.configDir, { recursive: true, force: true });
    }
  }

  select(role, id) {
    if (!ROLES.includes(role)) throw new Error(`unknown role "${role}"`);
    if (!this.get(id)) throw new Error('no such connection');
    this.state.selected[role] = id;
    this.#save();
  }
}

/** Environment for a run under a connection's account. */
export function connectionEnv(conn) {
  return conn?.kind === 'claude-code' && conn.configDir ? { CLAUDE_CONFIG_DIR: conn.configDir } : {};
}
