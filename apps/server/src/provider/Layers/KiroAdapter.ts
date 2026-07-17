import { type KiroSettings, ProviderDriverKind, type ProviderInstanceId } from "@t3tools/contracts";

import { makeKiroAcpRuntime, resolveKiroAcpModelId } from "../acp/KiroAcpSupport.ts";
import type { EventNdjsonLogger } from "./EventNdjsonLogger.ts";
import { makeGrokAdapter } from "./GrokAdapter.ts";

export interface KiroAdapterLiveOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
  readonly instanceId?: ProviderInstanceId;
}

/**
 * Kiro uses standard ACP session, model, permission, streaming, and
 * cancellation methods, so it shares the existing hardened ACP lifecycle
 * implementation instead of maintaining a third copy of that state machine.
 */
export function makeKiroAdapter(kiroSettings: KiroSettings, options?: KiroAdapterLiveOptions) {
  return makeGrokAdapter(kiroSettings, {
    ...options,
    provider: ProviderDriverKind.make("kiro"),
    providerDisplayName: "Kiro",
    resolveModelId: resolveKiroAcpModelId,
    makeAcpRuntime: ({ grokSettings: _grokSettings, ...input }) =>
      makeKiroAcpRuntime({
        ...input,
        kiroSettings,
      }),
  });
}
