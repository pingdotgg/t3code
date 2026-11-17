import { describe, expect, it } from "vite-plus/test";

import { connectionFloatingStatus } from "./floating-working-status";

describe("connectionFloatingStatus", () => {
  it.each([
    ["offline", "You are offline"],
    ["unsupported", "Client not supported"],
    ["error", "Sleeping. Your next message wakes it."],
    ["reconnecting", "Sleeping. Your next message wakes it."],
  ] as const)("a sleeping Boat VM in %s reads %s", (state, label) => {
    const status = connectionFloatingStatus({
      connectionError: null,
      connectionState: state,
      environmentLabel: "Boat VM",
      onReconnect: () => undefined,
      boatCloudSleep: "sleeping",
    });
    expect(status?.kind === "connection" ? status.label : null).toBe(label);
  });
});
