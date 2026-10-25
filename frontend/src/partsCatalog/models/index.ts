/** Every simulator model a card can name; importing this registers them. */
import '../simModels';
import './i2cSimple';
import './bosch';
import './i2cComplex';
import './spi';
import './line';
import './displays';
import './regmap';

export { getModuleModel, moduleModelNames } from './registry';
