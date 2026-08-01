import { NativeModule, registerWebModule } from 'expo';

import { HeartRatePpgModuleEvents } from './HeartRatePpg.types';

class HeartRatePpgModule extends NativeModule<HeartRatePpgModuleEvents> {
  async isAvailableAsync(): Promise<boolean> {
    return false;
  }

  async playBeatAsync(): Promise<void> {
  }

  async startMeasurementAsync(): Promise<void> {
    this.emit('onPpgUpdate', {
      status: 'failed',
      elapsedMs: 0,
      progress: 0,
      quality: 0,
      message: 'Tinh nang do bang camera chi ho tro tren iOS va Android.',
    });
  }

  async stopMeasurementAsync(): Promise<void> {
    this.emit('onPpgUpdate', {
      status: 'stopped',
      elapsedMs: 0,
      progress: 0,
      quality: 0,
    });
  }
}

export default registerWebModule(HeartRatePpgModule, 'HeartRatePpgModule');
