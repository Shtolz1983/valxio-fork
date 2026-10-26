// Starts the AI bridge at every login, so the IDE finds it without a
// terminal: a macOS LaunchAgent that runs start.mjs with the Node running this
// script, and starts the bridge again if it crashes.
//
//   npm run autostart                # install, start now
//   npm run autostart -- status      # installed? answering?
//   npm run autostart:remove         # stop, uninstall
//
// The agent gets the bridge's settings (AI_BRIDGE_PORT, VELXIO_URL, …) as they
// are when this runs, and this shell's PATH, so it finds `claude` like the
// terminal does. Output goes to ~/Library/Logs/velxio-ai-bridge.log.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { requireNode } from '../nodeVersion.mjs';

const LABEL = 'dev.velxio.ai-bridge';
const BRIDGE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PLIST = path.join(os.homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
const LOG = path.join(os.homedir(), 'Library', 'Logs', 'velxio-ai-bridge.log');
const PORT = Number(process.env.AI_BRIDGE_PORT ?? 8787);
/** What the bridge reads from its environment (server.mjs, connections.mjs, keyStore.mjs). */
const SETTINGS = ['AI_BRIDGE_PORT', 'AI_BRIDGE_ORIGINS', 'VELXIO_URL', 'VELXIO_AI_HOME', 'VELXIO_AI_KEYS', 'CLAUDE_BIN', 'CLAUDE_MODEL'];

const domain = () => `gui/${os.userInfo().uid}`;

function launchctl(...args) {
  return execFileSync('launchctl', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function xml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function plist() {
  const env = {
    // npm puts node_modules/.bin dirs in front; the agent needs the shell's own.
    PATH: (process.env.PATH ?? '').split(':').filter((p) => p && !p.includes(`node_modules${path.sep}.bin`)).join(':'),
  };
  for (const name of SETTINGS) if (process.env[name]) env[name] = process.env[name];
  const entries = Object.entries(env)
    .map(([k, v]) => `      <key>${xml(k)}</key><string>${xml(v)}</string>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key><string>${LABEL}</string>
    <key>ProgramArguments</key>
    <array>
      <string>${xml(process.execPath)}</string>
      <string>${xml(path.join(BRIDGE_DIR, 'start.mjs'))}</string>
    </array>
    <key>WorkingDirectory</key><string>${xml(BRIDGE_DIR)}</string>
    <key>EnvironmentVariables</key>
    <dict>
${entries}
    </dict>
    <key>RunAtLoad</key><true/>
    <!-- Restart after a crash, not after a clean exit (port taken by another bridge). -->
    <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
    <key>StandardOutPath</key><string>${xml(LOG)}</string>
    <key>StandardErrorPath</key><string>${xml(LOG)}</string>
  </dict>
</plist>
`;
}

async function answering() {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/health`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

/** The agent's pid, or null when it is not loaded or not running. */
function agentPid() {
  try {
    return /\bpid = (\d+)/.exec(launchctl('print', `${domain()}/${LABEL}`))?.[1] ?? null;
  } catch {
    return null;
  }
}

function unload() {
  try {
    launchctl('bootout', `${domain()}/${LABEL}`);
  } catch {
    // not loaded
  }
}

async function waitFor(check, ms) {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 300))) {
    if (await check()) return true;
  }
  return false;
}

async function install() {
  requireNode();
  unload();
  if (await answering()) {
    console.error(
      `A bridge started some other way is running on port ${PORT}.\n` +
        'Stop it (Ctrl+C in its terminal), then run npm run autostart again.',
    );
    process.exit(1);
  }
  mkdirSync(path.dirname(PLIST), { recursive: true });
  mkdirSync(path.dirname(LOG), { recursive: true });
  writeFileSync(PLIST, plist());
  launchctl('bootstrap', domain(), PLIST);
  if (await waitFor(answering, 15_000)) {
    console.log(`The AI bridge runs now and will start at every login (Node ${process.versions.node}).`);
    console.log(`Log: ${LOG}\nTo turn it off: npm run autostart:remove`);
  } else {
    console.error(`The bridge was installed but does not answer on port ${PORT}. See ${LOG}`);
    process.exit(1);
  }
}

async function remove() {
  unload();
  rmSync(PLIST, { force: true });
  await waitFor(async () => !(await answering()), 5_000);
  console.log('Autostart is off and the bridge it started is stopped.');
}

async function status() {
  const pid = agentPid();
  console.log(`Autostart: ${existsSync(PLIST) ? `on (${PLIST})` : 'off'}`);
  console.log(`Login agent: ${pid ? `running, pid ${pid}` : 'not running'}`);
  console.log(`Bridge on port ${PORT}: ${(await answering()) ? 'answering' : 'not answering'}`);
  console.log(`Log: ${LOG}`);
}

if (process.platform !== 'darwin') {
  console.error('Autostart is set up for macOS only. On this system run npm start in this folder and keep the terminal open.');
  process.exit(1);
}
const command = process.argv[2] ?? 'install';
const actions = { install, remove, status };
if (!actions[command]) {
  console.error(`Unknown command "${command}". Use: install, status or remove.`);
  process.exit(1);
}
await actions[command]();
