import { EnvironmentId, ORCHESTRATION_PROTOCOL_VERSION } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { orchestrationProtocolCompatibilityError } from "@t3tools/client-runtime/connection";

import { environmentStatusText } from "./environmentStatusText";

function compatibilityMessage(serverProtocolVersion: number): string {
  const error = orchestrationProtocolCompatibilityError({
    environmentId: EnvironmentId.make("environment-preview"),
    label: "Studio Mac",
    platform: { os: "darwin", arch: "arm64" },
    serverVersion: "1.0.0",
    orchestrationProtocolVersion: serverProtocolVersion,
    capabilities: { repositoryIdentity: true },
  });
  if (error === null) throw new Error("expected an incompatible protocol");
  return error.message;
}

describe("environment status text", () => {
  it.each([
    ["a newer server", ORCHESTRATION_PROTOCOL_VERSION + 1, "Update your app"],
    ["an older server", ORCHESTRATION_PROTOCOL_VERSION - 1, "Update T3 Code on Studio Mac"],
  ])("tells the user what to update for %s", (_, serverProtocolVersion, guidance) => {
    const text = environmentStatusText({
      phase: "unsupported",
      error: compatibilityMessage(serverProtocolVersion),
      traceId: null,
    });
    expect(text).toContain(guidance);
  });

  it("falls back to the generic label when there is no detail", () => {
    expect(environmentStatusText({ phase: "unsupported", error: null, traceId: null })).toBe(
      "Client not supported",
    );
  });
});
