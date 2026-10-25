// Checks parts-catalog cards: schema, libraries install, example compiles for
// Uno and ESP32 (against the Velxio backend, VELXIO_URL, default :3080).
//
//   npm run verify-cards                 # every card
//   npm run verify-cards -- ds18b20 bme280
//   npm run verify-cards -- --uno-only   # skip the slower ESP32 builds
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyCard } from '../partCards.mjs';

const CATALOG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../parts-catalog');
const velxioUrl = process.env.VELXIO_URL ?? 'http://localhost:3080';
const args = process.argv.slice(2);
const targets = args.includes('--uno-only') ? ['uno'] : ['uno', 'esp32'];
const only = args.filter((a) => !a.startsWith('--'));

const files = readdirSync(CATALOG)
  .filter((f) => f.endsWith('.json'))
  .filter((f) => only.length === 0 || only.includes(f.replace(/\.json$/, '')));

let failed = 0;
for (const file of files) {
  const card = JSON.parse(readFileSync(path.join(CATALOG, file), 'utf8'));
  const result = await verifyCard(card, { velxioUrl, targets });
  if (result.ok) {
    console.log(`ok    ${card.id}  (${result.steps.filter((s) => s.startsWith('example')).join('; ')})`);
  } else {
    failed++;
    console.log(`FAIL  ${card.id}\n${result.problems.map((p) => `      ${p.replace(/\n/g, '\n      ')}`).join('\n')}`);
  }
}
console.log(`\n${files.length - failed}/${files.length} cards pass`);
process.exit(failed ? 1 : 0);
