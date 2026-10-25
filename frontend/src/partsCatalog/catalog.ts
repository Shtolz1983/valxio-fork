/**
 * The parts catalogue in the editor: cards fetched from the backend
 * (/api/parts-catalog, the repo's parts-catalog/ folder) and fanned out to
 *
 *   - the component registry — a card without its own part becomes a generic
 *     `velxio-sensor-module` the picker and the canvas can place;
 *   - the parts knowledge (validation/partsKnowledge.ts) — pin roles, supply,
 *     I2C addresses and libraries for the validator and the AI's get_pins;
 *   - usePartCatalogStore — what the Sensors catalogue dialog lists.
 *
 * ComponentRegistry awaits loadPartCardComponents() while it loads, so a saved
 * project's modules resolve on the first render.
 */
import { create } from 'zustand';
import { getApiBase } from '../lib/apiBase';
import { registerPartKnowledge, type PartKnowledge } from '../validation/partsKnowledge';
import type { ComponentMetadata } from '../types/component-metadata';
import type { PartCard } from './types';

const FETCH_TIMEOUT_MS = 5000;
/** Chip models the ESP32's QEMU worker also has (ai-bridge/partCards.mjs keeps the same list). */
export const ESP32_SIM_MODELS = ['bh1750', 'aht20', 'sht31', 'bme280', 'dht11', 'ds18b20', 'tm1637', 'max7219', 'vl53l0x', 'max30102', 'adxl345', 'ina219', 'mlx90614', 'qmc5883l', 'ccs811', 'bmp180', 'bme680', 'max6675', 'max31865', 'rc522', 'regmap'];
export const MODULE_TAG = 'velxio-sensor-module';

interface PartCatalogState {
  cards: PartCard[];
  loaded: boolean;
  error: string | null;
}

export const usePartCatalogStore = create<PartCatalogState>(() => ({
  cards: [],
  loaded: false,
  error: null,
}));

function escapeXml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}

/** Small picker/catalogue thumbnail of a generic module. */
function moduleThumbnail(name: string, pinCount: number, color = '#1d5b8f'): string {
  const n = escapeXml(name.length > 9 ? `${name.slice(0, 8)}…` : name);
  const shown = Math.min(pinCount, 8);
  const pins = Array.from({ length: shown }, (_, i) => {
    const x = shown <= 1 ? 32 : 8 + (i * 48) / (shown - 1);
    return `<rect x="${x - 1}" y="6" width="2" height="8" fill="#c9c9c9"/>`;
  }).join('');
  return `<svg width="64" height="64" xmlns="http://www.w3.org/2000/svg"><rect x="2" y="12" width="60" height="36" rx="3" fill="${color}"/><rect x="26" y="37" width="12" height="8" rx="1" fill="#202020"/><text x="32" y="30" text-anchor="middle" font-family="sans-serif" font-size="9" font-weight="600" fill="#fff">${n}</text>${pins}</svg>`;
}

const url = (id?: string) => `${getApiBase()}/parts-catalog/${id ? encodeURIComponent(id) : ''}`;

/** Ids the registry got from cards, so a reload can drop the ones that went away. */
let moduleIds: string[] = [];

const SIGNAL_ROLES = new Set(['mcu-out', 'mcu-in', 'analog-in', 'bidir', 'spi-cs']);
const BUS_ROLES = new Set(['i2c-sda', 'i2c-scl', 'spi-sck', 'spi-mosi', 'spi-miso', 'spi-cs']);

export function cardKnowledge(card: PartCard): PartKnowledge {
  const signals = card.pins.filter((p) => SIGNAL_ROLES.has(p.role));
  const required = card.pins.filter((p) => BUS_ROLES.has(p.role)).map((p) => p.name);
  // A one-signal module (DQ, OUT, IO…) does nothing unless that pin is wired.
  if (signals.length === 1 && !required.includes(signals[0].name)) required.push(signals[0].name);
  return {
    label: `${card.name} — ${card.title}`,
    supply: card.supply,
    pins: Object.fromEntries(card.pins.map((p) => [p.name, p.role])),
    required,
    i2c: card.i2c
      ? { addresses: card.i2c.addresses.map((a) => parseInt(a, 16)).filter((n) => Number.isFinite(n)) }
      : undefined,
    libraries: card.libraries,
    notes: [
      ...card.pins.filter((p) => p.desc).map((p) => `${p.name}: ${p.desc}`),
      ...(card.pullups ?? []).map((p) => `${p.pin} needs a ${p.ohms} Ω pull-up to the supply.`),
      ...card.notes,
      ...simNotes(card),
    ],
  };
}

/** What the simulator lets a user (or the AI, through component properties) set. */
function simNotes(card: PartCard): string[] {
  if (card.component || !card.sim) return [];
  const where = card.sim.model
    ? ESP32_SIM_MODELS.includes(card.sim.model)
      ? ' Simulated on Uno, Nano, Mega, Pico and ESP32.'
      : ' Simulated on in-browser boards (Uno, Nano, Mega, Pico), not on ESP32.'
    : '';
  if (card.sim.controls.length === 0) return [`Simulated: the module shows what the sketch sends it.${where}`];
  const sliders = card.sim.controls.map((c) => `${c.key} ${c.min}..${c.max} ${c.unit}`.trim()).join(', ');
  return [`Simulated: set ${sliders} in the sensor panel or as component properties.${where}`];
}

/**
 * The display a card's simulator model paints on the module
 * (SensorModuleElement's `moduleDisplayKind`), so a placed module shows its
 * blank display before the simulation runs.
 */
const MODEL_DISPLAY_KIND: Record<string, '7seg' | 'matrix'> = { tm1637: '7seg', max7219: 'matrix' };

export function cardMetadata(card: PartCard): ComponentMetadata {
  const pins = card.pins.map((p) => p.name).join(',');
  const displayKind = card.sim?.model ? MODEL_DISPLAY_KIND[card.sim.model] : undefined;
  return {
    id: card.id,
    tagName: MODULE_TAG,
    name: card.name,
    category: 'sensors',
    description: card.title,
    thumbnail: moduleThumbnail(card.name, card.pins.length, card.color),
    properties: [],
    defaultValues: {
      moduleName: card.name,
      modulePins: pins,
      moduleColor: card.color ?? '#1d5b8f',
      ...(displayKind ? { moduleDisplayKind: displayKind } : {}),
    },
    pinCount: card.pins.length,
    tags: ['sensor', 'module', card.group, card.interface, card.name.toLowerCase()],
    keywords: [card.title, card.titleRu ?? ''].join(' ').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean),
  };
}

async function fetchCards(): Promise<PartCard[]> {
  const res = await fetch(url(), { cache: 'no-store', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`parts catalogue: HTTP ${res.status}`);
  const body = (await res.json()) as { cards?: PartCard[]; errors?: string[] };
  for (const e of body.errors ?? []) console.warn('[parts-catalog]', e);
  return (body.cards ?? []).filter((c) => c && typeof c.id === 'string' && Array.isArray(c.pins));
}

/**
 * Fetch the cards, register their knowledge and return the registry entries
 * of the generic modules. Never throws: without a backend the editor just
 * has no catalogue.
 */
export async function loadPartCardComponents(): Promise<ComponentMetadata[]> {
  let cards: PartCard[];
  try {
    cards = await fetchCards();
  } catch (err) {
    console.warn('[parts-catalog] not loaded:', err);
    usePartCatalogStore.setState({ loaded: true, error: err instanceof Error ? err.message : String(err) });
    return [];
  }
  for (const card of cards) registerPartKnowledge(card.component ?? card.id, cardKnowledge(card));
  try {
    const { registerCardSimulations } = await import('./simulation');
    registerCardSimulations(cards);
  } catch (err) {
    console.warn('[parts-catalog] simulation not registered:', err);
  }
  usePartCatalogStore.setState({ cards, loaded: true, error: null });
  const metas = cards.filter((c) => !c.component).map(cardMetadata);
  moduleIds = metas.map((m) => m.id);
  return metas;
}

/** Re-read the catalogue after a card was added, confirmed or deleted. */
export async function reloadPartCards(): Promise<void> {
  const { default: registry } = await import('../services/ComponentRegistry');
  const before = moduleIds;
  const metas = await loadPartCardComponents();
  const now = new Set(metas.map((m) => m.id));
  registry.removeComponents(before.filter((id) => !now.has(id)));
  registry.mergeComponents(metas);
}

async function request(method: 'PUT' | 'DELETE', id: string, body?: unknown): Promise<void> {
  const res = await fetch(url(id), {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const detail = await res.json().then((b) => b?.detail).catch(() => null);
    throw new Error(typeof detail === 'string' ? detail : `HTTP ${res.status}`);
  }
}

export async function confirmPartCard(card: PartCard): Promise<void> {
  await request('PUT', card.id, { ...card, status: 'verified' });
  await reloadPartCards();
}

export async function deletePartCard(id: string): Promise<void> {
  await request('DELETE', id);
  await reloadPartCards();
}
