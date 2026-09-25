import { PrimaryConnectionTarget, RelayConnectionTarget } from "@t3tools/client-runtime/connection";
import { EnvironmentId } from "@t3tools/contracts";
import type { RelayClientEnvironmentRecord } from "@t3tools/contracts/relay";
import { describe, expect, it } from "vite-plus/test";

import { environmentDisplayLabel } from "./environments";

const environmentId = EnvironmentId.make("this-machine");
const primary = new PrimaryConnectionTarget({
  environmentId,
  label: "MacBook Pro",
  httpBaseUrl: "http://localhost:3000",
  wsBaseUrl: "ws://localhost:3000/ws",
});
const shared: RelayClientEnvironmentRecord = {
  environmentId,
  label: "Work",
  endpoint: {
    httpBaseUrl: "https://relay.example.test",
    wsBaseUrl: "wss://relay.example.test/ws",
    providerKind: "manual",
  },
  linkedAt: "2026-09-23T12:00:00.000Z",
};

describe("environment display name", () => {
  it("shows the shared T3 Connect name on the environment that hosts this client", () => {
    expect(environmentDisplayLabel(environmentId, primary, [shared])).toBe("Work");
  });

  it("uses the machine name when this environment is not linked to the account", () => {
    expect(environmentDisplayLabel(environmentId, primary, null)).toBe("MacBook Pro");
    expect(environmentDisplayLabel(environmentId, primary, [])).toBe("MacBook Pro");
  });

  it("keeps another connection's own label", () => {
    const saved = new RelayConnectionTarget({ environmentId, label: "Saved name" });
    expect(environmentDisplayLabel(environmentId, saved, [shared])).toBe("Saved name");
  });
});
