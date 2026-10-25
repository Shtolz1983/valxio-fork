/**
 * Sensor/module knowledge card — one JSON file per part in the repo's
 * parts-catalog/ folder, served by the backend at /api/parts-catalog.
 * The format is documented in parts-catalog/README.md and checked by
 * ai-bridge/partCards.mjs (the schema both the seed cards and the AI's drafts
 * pass).
 */
import type { RegmapSpec } from './regmap';
import type { PinRole } from '../validation/partsKnowledge';

export type CardGroup =
  | 'climate'
  | 'light'
  | 'distance'
  | 'motion'
  | 'air'
  | 'water'
  | 'electrical'
  | 'biometric'
  | 'touch'
  | 'rfid'
  | 'sound'
  | 'display'
  | 'other';

export const CARD_GROUPS: CardGroup[] = [
  'climate',
  'light',
  'distance',
  'motion',
  'air',
  'water',
  'electrical',
  'biometric',
  'touch',
  'rfid',
  'sound',
  'display',
  'other',
];

export interface CardPin {
  name: string;
  role: PinRole;
  desc?: string;
}

export interface PartCard {
  id: string;
  name: string;
  title: string;
  titleRu?: string;
  group: CardGroup;
  interface: 'i2c' | 'spi' | '1-wire' | 'single-wire' | 'analog' | 'digital' | 'uart';
  /** An existing canvas part to place instead of the generic module. */
  component?: string;
  pins: CardPin[];
  supply: { min: number; max: number };
  i2c?: { addresses: string[] };
  pullups?: Array<{ pin: string; ohms: number }>;
  libraries: string[];
  /** Arduino sketch; `{{PIN}}` stands for the board pin wired to that card pin. */
  example: string;
  notes: string[];
  source?: { datasheet?: string; library?: string };
  status: 'verified' | 'draft';
  color?: string;
  /** How the generic module behaves in the simulator (none: wired but silent). */
  sim?: CardSim;
}

/** A slider in the sensor panel; its value lives in the component's properties under `key`. */
export interface CardSimControl {
  key: string;
  label: string;
  min: number;
  max: number;
  step: number;
  unit: string;
  default: number;
}

/**
 * A voltage on an analog pin, piecewise-linear in a control's value: `volts`
 * gives absolute volts, `ratio` a fraction of the board's analog rail
 * (ratiometric modules: a divider across the supply).
 */
export interface CardSimAnalogOutput {
  pin: string;
  kind: 'analog';
  from: string;
  volts?: Array<[number, number]>;
  ratio?: Array<[number, number]>;
}

/**
 * A level on a digital pin: active while the control is above `above` (or
 * below `below`; a 0/1 switch without either is active at 1). Active means
 * LOW for an `activeLow` output (open-collector DO, Hall switch).
 */
export interface CardSimDigitalOutput {
  pin: string;
  kind: 'digital';
  from: string;
  above?: number;
  below?: number;
  activeLow?: boolean;
}

export type CardSimOutput = CardSimAnalogOutput | CardSimDigitalOutput;

export interface CardSim {
  /** A chip model from partsCatalog/models (I2C, SPI, a data line, a display). */
  model?: string;
  controls: CardSimControl[];
  outputs?: CardSimOutput[];
  /** The chip as a register file, for `model: "regmap"` (partsCatalog/regmap.ts). */
  regmap?: RegmapSpec;
}

/** Canvas part a card places: its own component, or the generic module. */
export function cardComponentId(card: PartCard): string {
  return card.component ?? card.id;
}
