/**
 * Simulator models a parts-catalog card can name in `sim.model`.
 *
 * A model is the chip behind a generic module: it attaches to the running
 * board (an I2C target on the bus fabric, an SPI device, a line model on a
 * data pin, a display drawn on the module) and hears the sensor panel's
 * values through `update`. One file per family under this folder registers
 * its models; ./index.ts imports them all.
 *
 * The bridge's card check (ai-bridge/partCards.mjs, SIM_MODELS) lists the same
 * names with the control keys each model reads; the two lists must agree
 * (parts-catalog-models test).
 */
import type { AnySimulator } from '../../simulation/parts/PartSimulationRegistry';
import type { I2CDevice } from '../../simulation/I2CBusManager';
import { attachI2cPart } from '../../simulation/parts/i2cPart';
import type { PartCard } from '../types';

export interface ModuleModelContext {
  card: PartCard;
  componentId: string;
  /** The `<velxio-sensor-module>` node: displays draw on it. */
  element: HTMLElement;
  simulator: AnySimulator;
  /** Board pin wired to a card pin, as PartSimulationLogic hands it (null / <0: none). */
  getArduinoPin: (pinName: string) => number | null;
  /** The panel values at attach: defaults, then the project's on replay. */
  values: Record<string, number>;
}

export interface ModuleModelInstance {
  /** The panel moved: the full current value set. */
  update(values: Record<string, number>): void;
  dispose(): void;
}

export interface ModuleModel {
  /** Control keys the model reads; a card naming it must have a slider for each. */
  keys: string[];
  attach(ctx: ModuleModelContext): ModuleModelInstance;
}

const MODELS = new Map<string, ModuleModel>();

export function registerModuleModel(name: string, model: ModuleModel): void {
  MODELS.set(name, model);
}

export function getModuleModel(name: string): ModuleModel | undefined {
  return MODELS.get(name);
}

export function moduleModelNames(): string[] {
  return [...MODELS.keys()].sort();
}

/** A register-file I2C chip whose answers are a function of the panel values. */
export interface ValueI2cDevice extends I2CDevice {
  values: Record<string, number>;
}

/**
 * The usual I2C model: a device built at the card's first address, put on the
 * bus of the card's SDA/SCL pins, fed every panel change.
 *
 * `workerModel` names its Python twin in backend/app/services/
 * catalog_i2c_models.py: on a board whose firmware runs in a backend worker
 * (ESP32 under QEMU) the part files a `catalog-i2c` record with it and that
 * twin answers the guest. Without one, such a board has no copy of the chip.
 */
export function i2cModel(
  keys: string[],
  create: (address: number) => ValueI2cDevice,
  workerModel?: string,
): ModuleModel {
  return {
    keys,
    attach(ctx) {
      const { card } = ctx;
      const address = parseInt(card.i2c?.addresses[0] ?? '', 16);
      const device = create(Number.isFinite(address) ? address : 0);
      device.values = { ...ctx.values };
      const sda = card.pins.find((p) => p.role === 'i2c-sda')?.name ?? 'SDA';
      const scl = card.pins.find((p) => p.role === 'i2c-scl')?.name ?? 'SCL';
      const part = attachI2cPart({
        simulator: ctx.simulator,
        componentId: ctx.componentId,
        device,
        pins: { sda, scl },
        worker: workerModel ? { type: 'catalog-i2c', props: { model: workerModel, ...ctx.values } } : undefined,
      });
      return {
        update(values) {
          device.values = { ...values };
          part.updateWorker(values);
        },
        dispose() {
          part.dispose();
        },
      };
    },
  };
}
