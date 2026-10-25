/**
 * `"model": "regmap"`: the chip of a card that has no hand-written model,
 * answered from the register map the card carries (`sim.regmap`, engine in
 * ../regmap.ts). An I2C map sits on the bus of the card's SDA/SCL pins, an
 * SPI map on its SPI legs (hardware or bit-banged), both fed every panel
 * change.
 *
 * On an ESP32 the map travels to the worker with the part, and the worker's
 * twin (backend/app/services/catalog_regmap.py) answers the guest: an I2C
 * `catalog-i2c` record with model 'regmap', an SPI bus-map entry naming
 * catalog 'regmap'. The card check (ai-bridge/simCheck.mjs) runs the card's
 * example on a Nano and an ESP32 against this engine before the card is
 * written.
 */
import { attachSpiDevice, type SpiMode } from '../../simulation/buses';
import type { I2CDevice } from '../../simulation/I2CBusManager';
import { attachI2cPart } from '../../simulation/parts/i2cPart';
import { RegmapChip } from '../regmap';
import { registerModuleModel, type ModuleModelContext, type ModuleModelInstance } from './registry';
import { cardSpiPins } from './spi';

const NONE: ModuleModelInstance = { update() {}, dispose() {} };

function attachRegmap(ctx: ModuleModelContext): ModuleModelInstance {
  const { card, componentId } = ctx;
  const spec = card.sim?.regmap;
  if (!spec) return NONE;
  const chip = new RegmapChip(spec);
  chip.values = { ...ctx.values };

  if (spec.bus === 'spi') {
    const handle = attachSpiDevice(
      {
        owner: componentId,
        componentId,
        pins: cardSpiPins(card),
        modes: [((spec.spiMode ?? 0) & 3) as SpiMode],
        remoteModel: () => ({
          wasmB64: '',
          catalog: 'regmap',
          regmap: spec,
          chipPads: { sck: 'SCK', mosi: 'MOSI', miso: 'MISO', cs: 'CS' },
        }),
        remoteAttrs: () => ({ ...chip.values }),
      },
      {
        select: () => chip.select(),
        deselect: () => chip.deselect(),
        transfer: (mosi: number) => chip.transfer(mosi),
        peekMiso: () => chip.peekMiso(),
        boardReset: () => chip.powerOn(),
      },
    );
    return {
      update(values) {
        chip.values = { ...values };
        handle.attrsChanged();
      },
      dispose() {
        handle.dispose();
      },
    };
  }

  const address = parseInt(card.i2c?.addresses[0] ?? '', 16);
  const device: I2CDevice = {
    address: Number.isFinite(address) ? address : 0,
    start: (read: boolean) => chip.start(read),
    writeByte: (value: number) => chip.writeByte(value),
    readByte: () => chip.readByte(),
    stop: () => chip.stop(),
  };
  const part = attachI2cPart({
    simulator: ctx.simulator,
    componentId,
    device,
    pins: {
      sda: card.pins.find((p) => p.role === 'i2c-sda')?.name ?? 'SDA',
      scl: card.pins.find((p) => p.role === 'i2c-scl')?.name ?? 'SCL',
    },
    worker: { type: 'catalog-i2c', props: { model: 'regmap', regmap: spec, ...ctx.values } },
  });
  return {
    update(values) {
      chip.values = { ...values };
      part.updateWorker(values);
    },
    dispose() {
      part.dispose();
    },
  };
}

registerModuleModel('regmap', { keys: [], attach: attachRegmap });
