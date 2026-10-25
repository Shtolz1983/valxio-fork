// Claude Code accounts: who a config folder is signed in as, and signing a
// folder in from the IDE.
//
// `claude auth login` prints a sign-in link and waits for the code the
// sign-in page shows; the IDE opens the link and the user pastes the code,
// which goes to the process's stdin. Nothing here sees a password.
import { spawn } from 'node:child_process';

const STATUS_TIMEOUT_MS = 15_000;
const LOGIN_TIMEOUT_MS = 10 * 60_000;

/** No folder: the bridge's own environment, the login it runs under. */
function envFor(configDir) {
  return configDir ? { ...process.env, CLAUDE_CONFIG_DIR: configDir } : { ...process.env };
}

/** The sign-in link in `claude auth login` output (an OSC 8 hyperlink or a bare URL). */
export function loginUrl(text) {
  const m = /https:\/\/[^\s\x07\x1b]+\/oauth\/authorize\?[^\s\x07\x1b]+/.exec(text);
  return m ? m[0] : null;
}

/**
 * Who `configDir` (null: the bridge's own environment) is signed in as.
 * Resolves { loggedIn, email?, subscription?, error? }; never throws.
 */
export function accountStatus(bin, configDir) {
  return new Promise((resolve) => {
    let out = '';
    let child;
    try {
      child = spawn(bin, ['auth', 'status', '--json'], { env: envFor(configDir), stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      resolve({ loggedIn: false, error: err.message });
      return;
    }
    const timer = setTimeout(() => child.kill('SIGTERM'), STATUS_TIMEOUT_MS);
    child.stdout.on('data', (d) => (out += d));
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ loggedIn: false, error: err.code === 'ENOENT' ? `${bin} is not installed` : err.message });
    });
    child.on('close', () => {
      clearTimeout(timer);
      try {
        const s = JSON.parse(out);
        resolve({ loggedIn: !!s.loggedIn, email: s.email, subscription: s.subscriptionType });
      } catch {
        resolve({ loggedIn: false, error: 'could not read the account status' });
      }
    });
  });
}

/**
 * Start `claude auth login` for `configDir`. `onUpdate({ url?, waitingForCode?, done?, ok?, error? })`
 * reports progress. Returns { submitCode(code), cancel() }.
 */
export function startLogin(bin, configDir, onUpdate) {
  let text = '';
  let urlSent = false;
  let finished = false;
  const child = spawn(bin, ['auth', 'login'], {
    // The IDE opens the link itself, in the browser the user is in.
    env: { ...envFor(configDir), BROWSER: process.platform === 'win32' ? 'echo' : '/usr/bin/true' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const finish = (result) => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    onUpdate({ done: true, ...result });
  };
  const timer = setTimeout(() => {
    child.kill('SIGTERM');
    finish({ ok: false, error: 'sign-in timed out' });
  }, LOGIN_TIMEOUT_MS);
  const onText = (chunk) => {
    text = (text + chunk.toString()).slice(-8000);
    const url = loginUrl(text);
    if (url && !urlSent) {
      urlSent = true;
      onUpdate({ url, waitingForCode: true });
    }
  };
  child.stdout.on('data', onText);
  child.stderr.on('data', onText);
  child.on('error', (err) => finish({ ok: false, error: err.code === 'ENOENT' ? `${bin} is not installed` : err.message }));
  child.on('close', async (code) => {
    if (finished) return;
    const status = await accountStatus(bin, configDir);
    finish(status.loggedIn ? { ok: true, email: status.email } : { ok: false, error: code === 0 ? 'not signed in' : lastLine(text) });
  });
  return {
    submitCode(code) {
      const c = String(code ?? '').trim();
      if (c && !finished) child.stdin.write(`${c}\n`);
    },
    cancel() {
      child.kill('SIGTERM');
      finish({ ok: false, error: 'cancelled' });
    },
  };
}

function lastLine(text) {
  // eslint-disable-next-line no-control-regex
  const lines = text.replace(/\x1b\][^\x07]*\x07|\x1b\[[0-9;]*m/g, '').split('\n').map((l) => l.trim()).filter(Boolean);
  return lines[lines.length - 1]?.slice(0, 200) ?? 'sign-in failed';
}
