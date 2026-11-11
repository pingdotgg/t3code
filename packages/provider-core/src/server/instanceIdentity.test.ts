import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { instanceDisplayName } from "./instanceIdentity.ts";

const codex = ProviderDriverKind.make("codex");

describe("instanceDisplayName", () => {
  // regression: #34507 clients could not tell an explicit "Codex" from the driver label
  it("sends the driver label only for the default instance", () => {
    expect(
      instanceDisplayName({
        instanceId: ProviderInstanceId.make("codex_pool"),
        driverKind: codex,
        displayName: undefined,
        driverLabel: "Codex",
      }),
    ).toEqual({});
    expect(
      instanceDisplayName({
        instanceId: ProviderInstanceId.make("codex"),
        driverKind: codex,
        displayName: undefined,
        driverLabel: "Codex",
      }),
    ).toEqual({ displayName: "Codex" });
  });
});
