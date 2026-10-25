/**
 * Simulator behaviour of the generic sensor modules, from a card's `sim`:
 *
 *   - `controls` become the sliders of the sensor panel (and of the property
 *     dialog), registered under the card id like any built-in sensor;
 *   - `outputs` put a voltage on an analog pin or a level on a digital pin,
 *     computed from a slider's value;
 *   - `model` is the chip behind the module (models/registry.ts): an I2C or
 *     SPI device, a line model on a data pin, a display drawn on the module.
 *
 * Loaded on demand by catalog.ts, so the registry's load does not pull the
 * simulator in.
 */
import { PartSimulationRegistry } from '../simulation/parts/PartSimulationRegistry';
import { registerSensorControls, type SensorControlDef } from '../simulation/sensorControlConfig';
import { registerSensorUpdate, unregisterSensorUpdate } from '../simulation/SensorUpdateRegistry';
import { analogRailVolts, setAdcVoltage } from '../simulation/parts/partUtils';
import { getModuleModel } from './models';
import { onBoardBooted } from './boardBoot';
import type { CardSim, CardSimAnalogOutput, CardSimDigitalOutput, CardSimOutput, PartCard } from './types';

/** Piecewise-linear lookup; outside the points it holds the end values. */
export function interpolate(points: Array<[number, number]>, x: number): number {
  const pts = [...points].sort((a, b) => a[0] - b[0]);
  if (pts.length === 0) return 0;
  if (x <= pts[0][0]) return pts[0][1];
  for (let i = 1; i < pts.length; i++) {
    const [x1, y1] = pts[i];
    if (x <= x1) {
      const [x0, y0] = pts[i - 1];
      return x1 === x0 ? y1 : y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
    }
  }
  return pts[pts.length - 1][1];
}

/** Volts an analog output puts on its pin, clamped to the board's ADC rail. */
export function analogVolts(out: CardSimAnalogOutput, value: number, railVolts: number): number {
  const v = out.volts ? interpolate(out.volts, value) : interpolate(out.ratio ?? [], value) * railVolts;
  return Math.min(railVolts, Math.max(0, v));
}

/** The level (true = HIGH) a digital output drives for a control value. */
export function digitalLevel(out: CardSimDigitalOutput, value: number): boolean {
  const active =
    out.above !== undefined ? value > out.above : out.below !== undefined ? value < out.below : value >= 0.5;
  return out.activeLow ? !active : active;
}

export function sensorControlDef(card: PartCard, sim: CardSim): SensorControlDef {
  return {
    title: card.name,
    controls: sim.controls.map((c) => ({
      type: 'slider' as const,
      key: c.key,
      label: c.label,
      min: c.min,
      max: c.max,
      step: c.step,
      unit: c.unit,
      defaultValue: c.default,
    })),
    defaultValues: Object.fromEntries(sim.controls.map((c) => [c.key, c.default])),
  };
}

/** Register the panel controls and the part logic of every card that has `sim`. */
export function registerCardSimulations(cards: PartCard[]): void {
  for (const card of cards) {
    if (card.component || !card.sim) continue;
    if (card.sim.controls.length === 0 && !card.sim.model) continue;
    registerCardSimulation(card, card.sim);
  }
}

function registerCardSimulation(card: PartCard, sim: CardSim): void {
  const def = sensorControlDef(card, sim);
  // A display has nothing to set: no panel opens on it.
  if (sim.controls.length > 0) registerSensorControls({ [card.id]: def });
  const model = sim.model ? getModuleModel(sim.model) : undefined;
  if (sim.model && !model) console.warn(`[parts-catalog] ${card.id}: no simulator model "${sim.model}"`);

  PartSimulationRegistry.register(card.id, {
    attachEvents: (element, simulator, getArduinoPin, componentId) => {
      const values: Record<string, number> = { ...(def.defaultValues as Record<string, number>) };
      const rail = analogRailVolts(simulator);
      const outputs = (sim.outputs ?? [])
        .map((out) => ({ out, pin: getArduinoPin(out.pin) }))
        .filter((o): o is { out: CardSimOutput; pin: number } => o.pin !== null && o.pin >= 0);

      const chip = model?.attach({ card, componentId, element, simulator, getArduinoPin, values: { ...values } });

      const apply = () => {
        for (const { out, pin } of outputs) {
          const value = values[out.from] ?? 0;
          if (out.kind === 'analog') setAdcVoltage(simulator, pin, analogVolts(out, value, rail));
          else simulator.setPinState(pin, digitalLevel(out, value));
        }
        chip?.update({ ...values });
      };
      apply();
      // An ESP32 worker boots after the part attached and starts at 0 V:
      // put the levels again once it is up.
      const offBoot = outputs.length ? onBoardBooted(simulator, apply) : () => {};

      registerSensorUpdate(componentId, (update) => {
        for (const [key, v] of Object.entries(update)) {
          if (typeof v === 'number') values[key] = v;
          else if (typeof v === 'boolean') values[key] = v ? 1 : 0;
        }
        apply();
      });

      return () => {
        offBoot();
        chip?.dispose();
        unregisterSensorUpdate(componentId);
      };
    },
  });
}
