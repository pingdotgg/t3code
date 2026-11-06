import { RelayConnectionTarget, type PreparedConnection } from "@t3tools/client-runtime/connection";
import { getEnvironmentSpeechStatus } from "@t3tools/client-runtime/voice-input";
import { EnvironmentId } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";

import { speechRuntime } from "./runtime";

it("authorizes relay speech requests through the connection session", async () => {
  const target = new RelayConnectionTarget({
    environmentId: EnvironmentId.make("speech-relay-test"),
    label: "Speech destination",
  });
  const prepared: PreparedConnection = {
    target,
    environmentId: target.environmentId,
    label: target.label,
    httpBaseUrl: "https://speech.example.test",
    socketUrl: "wss://speech.example.test/ws",
    httpAuthorization: { _tag: "Dpop", accessToken: "expired", expiresAtEpochMs: 0 },
  };
  // No account is signed in: renewal must reach the authorizer rather than fail on a missing service.
  await expect(speechRuntime.runPromise(getEnvironmentSpeechStatus(prepared))).rejects.toThrow(
    "Could not authorize the environment request.",
  );
});
