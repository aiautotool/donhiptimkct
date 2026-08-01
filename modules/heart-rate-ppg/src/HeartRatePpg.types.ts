export type PpgStatus = 'idle' | 'warming' | 'measuring' | 'complete' | 'failed' | 'stopped';

export type PpgUpdatePayload = {
  status: PpgStatus;
  elapsedMs: number;
  progress: number;
  bpm?: number;
  quality: number;
  signal?: number;
  message?: string;
};

export type HeartRatePpgModuleEvents = {
  onPpgUpdate: (params: PpgUpdatePayload) => void;
};
