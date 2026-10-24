import { ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveThreadVoiceAvailability } from "./voiceAvailability";

const codex = ProviderInstanceId.make("codex");
const claude = ProviderInstanceId.make("claudeAgent");
const providers = [
  { instanceId: codex, supportsVoice: true },
  { instanceId: claude },
] as unknown as ReadonlyArray<ServerProvider>;

function thread(input: { readonly provider: ProviderInstanceId; readonly messages?: boolean }) {
  return {
    providerInstanceId: input.provider,
    latestUserMessageAt: input.messages ? "2026-09-22T00:00:00.000Z" : null,
    activeProviderThreadId: input.messages ? "provider-thread-1" : null,
  };
}

describe("resolveThreadVoiceAvailability", () => {
  it("hides voice for providers that do not support it", () => {
    expect(
      resolveThreadVoiceAvailability(thread({ provider: claude, messages: true }), providers),
    ).toEqual({ kind: "unsupported" });
  });

  it("explains that a new thread needs a first message", () => {
    expect(resolveThreadVoiceAvailability(thread({ provider: codex }), providers)).toEqual({
      kind: "unavailable",
      reason: "Send a message before starting voice",
    });
  });

  it("is ready once a Codex thread has run", () => {
    expect(
      resolveThreadVoiceAvailability(thread({ provider: codex, messages: true }), providers),
    ).toEqual({ kind: "ready" });
  });
});
