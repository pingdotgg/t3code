import {
  type DesktopPreviewManagedSessionResult,
  PreviewAutomationManagedTargetAuthError,
  type PreviewAutomationRequest,
  type ScopedThreadRef,
} from "@t3tools/contracts";

import { previewBridge } from "./previewBridge";

export interface ManagedPreviewTarget {
  readonly environmentId: ScopedThreadRef["environmentId"];
  readonly expectedOrigins: ReadonlyArray<string>;
}

export async function prepareManagedPreviewTarget(input: {
  readonly request: PreviewAutomationRequest;
  readonly threadRef: ScopedThreadRef;
  readonly targetUrl: string;
  readonly profileId?: string;
}): Promise<ManagedPreviewTarget | null> {
  const managedTargetAuth = input.request.managedTargetAuth;
  if (!managedTargetAuth) return null;

  const fail = (reason: PreviewAutomationManagedTargetAuthError["reason"]) => {
    throw new PreviewAutomationManagedTargetAuthError({
      operation: input.request.operation,
      environmentId: input.threadRef.environmentId,
      threadId: input.threadRef.threadId,
      requestId: input.request.requestId,
      timeoutMs: input.request.timeoutMs,
      reason,
    });
  };
  const bridge = previewBridge;
  if (!bridge) return fail("bootstrap-failed");

  let result: DesktopPreviewManagedSessionResult;
  try {
    result = await bridge.bootstrapManagedPreviewSession({
      environmentId: input.threadRef.environmentId,
      ...(input.profileId === undefined ? {} : { profileId: input.profileId }),
      targetUrl: input.targetUrl,
      managedTargetAuth,
      timeoutMs: input.request.timeoutMs,
    });
  } catch {
    return fail("bootstrap-failed");
  }

  switch (result._tag) {
    case "authenticated":
      return {
        environmentId: input.threadRef.environmentId,
        expectedOrigins: managedTargetAuth.expectedOrigins,
      };
    case "not-managed":
      return null;
    case "failed":
      return fail(result.reason);
  }
}
