/**
 * The command shown in the AI panel while the bridge does not answer: it
 * installs the bridge's dependencies and its login agent (ai-bridge
 * `npm run autostart`), which starts it now and at every login.
 *
 * The folder is this computer's ai-bridge when the build knows it (the dev
 * server's own checkout, or AI_BRIDGE_DIR passed by docker-compose) and the
 * page is opened on this computer; a page served from another host gets a
 * placeholder, since the bridge runs where the browser is.
 */
declare const __AI_BRIDGE_DIR__: string | undefined;

const LOCAL_HOSTS = ['localhost', '127.0.0.1', '[::1]', '::1'];

export function bridgeDir(hostname = location.hostname): string | null {
  const dir = typeof __AI_BRIDGE_DIR__ === 'string' ? __AI_BRIDGE_DIR__ : '';
  return dir && LOCAL_HOSTS.includes(hostname) ? dir : null;
}

/** `placeholder` stands for the folder when it is not known, e.g. "<project folder>/ai-bridge". */
export function autostartCommand(dir: string | null, placeholder: string): string {
  const folder = dir ? (/\s/.test(dir) ? `"${dir}"` : dir) : placeholder;
  return `cd ${folder} && npm install && npm run autostart`;
}
