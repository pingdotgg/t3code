import type { ServerSettings, ServerSettingsPatch } from "@t3tools/contracts";

export interface ServerSettingsWriteQueue {
  readonly enqueue: (patch: ServerSettingsPatch) => void;
  readonly reset: () => void;
  readonly drain: () => Promise<void>;
}

export function createServerSettingsWriteQueue(input: {
  readonly updateSettings: (patch: ServerSettingsPatch) => Promise<ServerSettings>;
  readonly applySettings: (settings: ServerSettings) => void;
  readonly onError: (error: unknown) => void;
}): ServerSettingsWriteQueue {
  let queue: Promise<void> = Promise.resolve();

  return {
    enqueue: (patch) => {
      queue = queue
        .catch(() => undefined)
        .then(async () => {
          const settings = await input.updateSettings(patch);
          input.applySettings(settings);
        })
        .catch(input.onError);
    },
    reset: () => {
      queue = Promise.resolve();
    },
    drain: () => queue,
  };
}
