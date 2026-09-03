import type {
  PreviewResizeInput,
  PreviewResizeResult,
  PreviewStateVersion,
  PreviewViewportSetting,
} from "@t3tools/contracts";

export interface PreviewViewportRollbackState {
  readonly previousSetting: PreviewViewportSetting;
  readonly stateVersion: PreviewStateVersion;
  readonly input: PreviewResizeInput;
}

export function createPreviewViewportRollbackState(options: {
  readonly result: PreviewResizeResult;
  readonly threadId: PreviewResizeInput["threadId"];
  readonly tabId: PreviewResizeInput["tabId"];
}): PreviewViewportRollbackState | undefined {
  const stateVersion = options.result.stateVersion;
  const previousSetting = options.result.previousViewport;
  if (!stateVersion || !previousSetting) return undefined;
  return {
    previousSetting,
    stateVersion,
    input: {
      threadId: options.threadId,
      tabId: options.tabId,
      viewport: previousSetting,
      expectedStateVersion: stateVersion,
    },
  };
}

export async function applyPreviewViewportRollback(options: {
  readonly previous: PreviewViewportSetting;
  readonly applyGuest: (setting: PreviewViewportSetting) => Promise<void>;
  readonly rollbackServer: () => Promise<boolean>;
}): Promise<void> {
  if (!(await options.rollbackServer())) return;
  void options.applyGuest(options.previous).catch(() => undefined);
}
