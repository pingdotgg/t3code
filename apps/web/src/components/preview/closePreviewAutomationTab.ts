import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  PreviewCloseInput,
  PreviewSessionSnapshot,
  ScopedThreadRef,
} from "@t3tools/contracts";

import { closePreviewSession } from "./closePreviewSession";

interface ClosePreviewAutomationTabInput<E> {
  readonly closePreview: (input: {
    readonly environmentId: EnvironmentId;
    readonly input: PreviewCloseInput;
  }) => Promise<AtomCommandResult<void, E>>;
  readonly closeRuntimeTab: (runtimeTabId: string) => Promise<void>;
  readonly runtimeTabId: string;
  readonly snapshot: PreviewSessionSnapshot | null;
  readonly tabId: string;
  readonly threadRef: ScopedThreadRef;
}

/**
 * Removes the authoritative preview session before disposing its local Electron
 * runtime. A failed server close leaves the runtime available for a retry.
 */
export async function closePreviewAutomationTab<E>(
  input: ClosePreviewAutomationTabInput<E>,
): Promise<AtomCommandResult<void, E>> {
  const result = await closePreviewSession(input);
  if (result._tag === "Failure") return result;
  await input.closeRuntimeTab(input.runtimeTabId);
  return result;
}
