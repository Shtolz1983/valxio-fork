import { describe, it, expect } from 'vitest';
import { validateCircuit, type ValidatorInput } from '../validation/circuitValidator';

type Part = { id: string; metadataId: string; properties?: Record<string, unknown> };

let wireSeq = 0;
function circuit(
  boards: Array<[id: string, kind: string]>,
  parts: Part[],
  links: Array<[from: string, to: string]>,
  code?: Record<string, string>,
): ValidatorInput {
  const ep = (ref: string) => {
    const i = ref.indexOf(':');
    return { componentId: ref.slice(0, i), pinName: ref.slice(i + 1) };
  };
  return {
    boards: boards.map(([id, boardKind]) => ({ id, boardKind })),
    components: parts,
    wires: links.map(([a, b]) => ({ id: `w${wireSeq++}`, start: ep(a), end: ep(b) })),
    code,
  };
}

const codes = (input: ValidatorInput) => validateCircuit(input).map((w) => w.code);

const ESP = [['esp32', 'esp32']] as Array<[string, string]>;
const OLED = (id: string, addr = '0x3c'): Part => ({ id, metadataId: 'ssd1306-i2c-4pin', properties: { i2cAddress: addr } });
const oledWires = (id: string, sda = '21', scl = '22'): Array<[string, string]> => [
  ['esp32:3V3', `${id}:VCC`],
  ['esp32:GND', `${id}:GND`],
  [`esp32:${sda}`, `${id}:SDA`],
  [`esp32:${scl}`, `${id}:SCL`],
];

describe('validateCircuit', () => {
  it('passes a correctly wired ESP32 weather station', () => {
    const input = circuit(
      ESP,
      [{ id: 'dht1', metadataId: 'dht22' }, OLED('oled1')],
      [['esp32:3V3', 'dht1:VCC'], ['esp32:GND', 'dht1:GND'], ['esp32:4', 'dht1:SDA'], ...oledWires('oled1')],
      { esp32: 'void setup(){ Wire.begin(); }' },
    );
    expect(validateCircuit(input)).toEqual([]);
  });

  it('flags an LED driven from an input-only ESP32 pin, through its resistor', () => {
    const input = circuit(
      ESP,
      [{ id: 'r1', metadataId: 'resistor-220' }, { id: 'led1', metadataId: 'led' }],
      [['esp32:34', 'r1:1'], ['r1:2', 'led1:A'], ['led1:C', 'esp32:GND']],
    );
    const found = validateCircuit(input).find((w) => w.code === 'input-only-pin');
    expect(found?.severity).toBe('error');
    expect(found?.componentId).toBe('led1');
  });

  it('accepts an input-only pin for a part the board only reads', () => {
    const input = circuit(
      ESP,
      [{ id: 'pir1', metadataId: 'pir-motion-sensor' }],
      [['esp32:VIN', 'pir1:VCC'], ['esp32:GND', 'pir1:GND'], ['esp32:34', 'pir1:OUT']],
    );
    expect(codes(input)).not.toContain('input-only-pin');
  });

  it('flags two OLEDs at the same I2C address and clears it when one moves to 0x3D', () => {
    const same = circuit(ESP, [OLED('o1'), OLED('o2')], [...oledWires('o1'), ...oledWires('o2')]);
    const conflict = validateCircuit(same).find((w) => w.code === 'i2c-address-conflict');
    expect(conflict?.message).toContain('0x3c');
    expect(conflict?.message).toContain('0x3d');

    const fixed = circuit(ESP, [OLED('o1'), OLED('o2', '0x3d')], [...oledWires('o1'), ...oledWires('o2')]);
    expect(codes(fixed)).not.toContain('i2c-address-conflict');
  });

  it('reads the MPU6050 address from its AD0 strap', () => {
    const mpuWires = (id: string): Array<[string, string]> => [
      ['esp32:3V3', `${id}:VCC`],
      ['esp32:GND', `${id}:GND`],
      ['esp32:21', `${id}:SDA`],
      ['esp32:22', `${id}:SCL`],
    ];
    const parts = [
      { id: 'm1', metadataId: 'mpu6050' },
      { id: 'm2', metadataId: 'mpu6050' },
    ];
    expect(codes(circuit(ESP, parts, [...mpuWires('m1'), ...mpuWires('m2')]))).toContain('i2c-address-conflict');
    expect(
      codes(circuit(ESP, parts, [...mpuWires('m1'), ...mpuWires('m2'), ['esp32:3V3', 'm2:AD0']])),
    ).not.toContain('i2c-address-conflict');
  });

  it('flags swapped SDA/SCL', () => {
    expect(codes(circuit(ESP, [OLED('o1')], oledWires('o1', '22', '21')))).toContain('i2c-pins');
  });

  it('asks for Wire.begin(sda, scl) when an ESP32 bus is on non-default pins', () => {
    const wires = oledWires('o1', '16', '17');
    expect(codes(circuit(ESP, [OLED('o1')], wires, { esp32: 'void setup(){ Wire.begin(); }' }))).toContain('i2c-pins');
    expect(codes(circuit(ESP, [OLED('o1')], wires, { esp32: 'void setup(){ Wire.begin(16, 17); }' }))).not.toContain('i2c-pins');
  });

  it('requires hardware I2C pins on the Uno, including the SDA/SCL pads beside AREF', () => {
    const uno = [['uno', 'arduino-uno']] as Array<[string, string]>;
    const wires = (sda: string, scl: string): Array<[string, string]> => [
      ['uno:5V', 'o1:VCC'],
      ['uno:GND.1', 'o1:GND'],
      [`uno:${sda}`, 'o1:SDA'],
      [`uno:${scl}`, 'o1:SCL'],
    ];
    expect(validateCircuit(circuit(uno, [OLED('o1')], wires('2', '3'))).find((w) => w.code === 'i2c-pins')?.severity).toBe('error');
    expect(codes(circuit(uno, [OLED('o1')], wires('A4.2', 'A5.2')))).not.toContain('i2c-pins');
  });

  it('warns about an HC-SR04 under-powered from 3.3 V, and about its 5 V ECHO into a 3.3 V board', () => {
    const base: Array<[string, string]> = [['esp32:GND', 'us1:GND'], ['esp32:5', 'us1:TRIG'], ['esp32:18', 'us1:ECHO']];
    const parts = [{ id: 'us1', metadataId: 'hc-sr04' }];
    expect(codes(circuit(ESP, parts, [...base, ['esp32:3V3', 'us1:VCC']]))).toContain('supply-range');
    const at5 = codes(circuit(ESP, parts, [...base, ['esp32:VIN', 'us1:VCC']]));
    expect(at5).toContain('logic-level');
    expect(at5).not.toContain('supply-range');
  });

  it('does not raise logic-level on a 5 V board', () => {
    const uno = [['uno', 'arduino-uno']] as Array<[string, string]>;
    const input = circuit(uno, [{ id: 'us1', metadataId: 'hc-sr04' }], [
      ['uno:5V', 'us1:VCC'],
      ['uno:GND.1', 'us1:GND'],
      ['uno:9', 'us1:TRIG'],
      ['uno:10', 'us1:ECHO'],
    ]);
    expect(codes(input)).not.toContain('logic-level');
  });

  it('flags a required signal pin left unwired', () => {
    const wires = oledWires('o1').filter(([, to]) => to !== 'o1:SCL');
    const found = validateCircuit(circuit(ESP, [OLED('o1')], wires)).find((w) => w.code === 'unwired-signal');
    expect(found?.message).toContain('SCL');
  });

  it('flags two parts driving one GPIO', () => {
    const input = circuit(
      ESP,
      [{ id: 'btn1', metadataId: 'pushbutton' }, { id: 'pir1', metadataId: 'pir-motion-sensor' }],
      [['esp32:13', 'btn1:1.l'], ['btn1:2.l', 'esp32:GND'], ['esp32:13', 'pir1:OUT'], ['esp32:VIN', 'pir1:VCC'], ['esp32:GND', 'pir1:GND']],
    );
    expect(codes(input)).toContain('pin-conflict');
  });

  it('flags analog parts on pins without an ADC, and ADC2 pins while Wi-Fi is used', () => {
    const uno = [['uno', 'arduino-uno']] as Array<[string, string]>;
    const pot = [{ id: 'p1', metadataId: 'potentiometer' }];
    expect(codes(circuit(uno, pot, [['uno:5V', 'p1:VCC'], ['uno:GND.1', 'p1:GND'], ['uno:7', 'p1:SIG']]))).toContain('no-adc');

    const espPot: Array<[string, string]> = [['esp32:3V3', 'p1:VCC'], ['esp32:GND', 'p1:GND'], ['esp32:25', 'p1:SIG']];
    expect(codes(circuit(ESP, pot, espPot, { esp32: '#include <WiFi.h>\nvoid setup(){}' }))).toContain('adc2-wifi');
    expect(codes(circuit(ESP, pot, espPot, { esp32: 'void setup(){}' }))).not.toContain('adc2-wifi');
  });

  it('flags a part on the ESP32 flash pins', () => {
    const board = [['esp32', 'esp32-devkit-c-v4']] as Array<[string, string]>;
    const input = circuit(board, [{ id: 'led1', metadataId: 'led' }], [['esp32:CLK', 'led1:A'], ['led1:C', 'esp32:GND.1']]);
    expect(codes(input)).toContain('flash-pin');
  });
});
