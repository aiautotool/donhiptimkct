import { NativeModule, requireNativeModule } from 'expo';

import { HeartRatePpgModuleEvents } from './HeartRatePpg.types';

declare class HeartRatePpgModule extends NativeModule<HeartRatePpgModuleEvents> {
  isAvailableAsync(): Promise<boolean>;
  startMeasurementAsync(durationSeconds?: number): Promise<void>;
  stopMeasurementAsync(): Promise<void>;
}

export default requireNativeModule<HeartRatePpgModule>('HeartRatePpg');
