import { describe, expect, it } from "vite-plus/test";

import { connectionFloatingStatus } from "./floating-working-status";

describe("connectionFloatingStatus", () => {
  it.each([
    ["offline", false, "You are offline"],
    ["unsupported", false, "Client not supported"],
    ["reconnecting", true, "Waiting for Boat VM to approve this device"],
    ["error", false, "Sleeping. Your next message wakes it."],
    ["reconnecting", false, "Sleeping. Your next message wakes it."],
  ] as const)(
    "a sleeping Boat VM in %s (awaiting approval %s) reads %s",
    (state, awaiting, label) => {
      const status = connectionFloatingStatus({
        connectionError: null,
        connectionState: state,
        connectionAwaitingApproval: awaiting,
        environmentLabel: "Boat VM",
        onReconnect: () => undefined,
        boatCloudSleep: "sleeping",
      });
      expect(status?.kind === "connection" ? status.label : null).toBe(label);
    },
  );
});
