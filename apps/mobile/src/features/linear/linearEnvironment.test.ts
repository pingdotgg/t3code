import type { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveLinearEnvironmentId, resolveLinearTabState } from "./linearEnvironment";

const env = (id: string, connectionState = "connected", isEnabled = true) => ({
  environmentId: id as EnvironmentId,
  connectionState,
  isEnabled,
});

describe("resolveLinearEnvironmentId", () => {
  it("keeps the pick while connected, else falls back to the first connected environment", () => {
    const environments = [env("a", "connecting"), env("b"), env("c")];
    expect(resolveLinearEnvironmentId(environments, "c" as EnvironmentId)).toBe("c");
    expect(resolveLinearEnvironmentId(environments, "a" as EnvironmentId)).toBe("b");
    expect(resolveLinearEnvironmentId(environments, null)).toBe("b");
    expect(resolveLinearEnvironmentId([env("a", "connected", false)], null)).toBeNull();
  });
});

describe("resolveLinearTabState", () => {
  const base = {
    environmentId: "a" as EnvironmentId,
    connection: null,
    failure: null,
    hasError: false,
  };
  it("reads the connection state, then the status failure", () => {
    expect(resolveLinearTabState({ ...base, environmentId: null })).toBe("no-environment");
    expect(resolveLinearTabState(base)).toBe("loading");
    expect(resolveLinearTabState({ ...base, connection: "connected" })).toBe("connected");
    expect(resolveLinearTabState({ ...base, connection: "invalid" })).toBe("invalid");
    expect(resolveLinearTabState({ ...base, connection: "disconnected" })).toBe("disconnected");
    const unauthorized = { _tag: "LinearError", reason: "unauthorized" };
    expect(resolveLinearTabState({ ...base, failure: unauthorized, hasError: true })).toBe(
      "invalid",
    );
    expect(
      resolveLinearTabState({
        ...base,
        failure: "Unknown request tag: linear.status",
        hasError: true,
      }),
    ).toBe("unsupported");
    expect(resolveLinearTabState({ ...base, failure: new Error("offline"), hasError: true })).toBe(
      "unreachable",
    );
  });
});
