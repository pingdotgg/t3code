import { EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { EnvironmentConnectionPhase } from "./connection/presentation.ts";
import {
  fleetQueueCreateTurnInput,
  fleetSeatAddress,
  fleetSeatAddressabilityHint,
  fleetSeatCommandTarget,
  fleetSeatFromRemoteChild,
  resolveFleetSeatAddressability,
} from "./fleetAddress.ts";

const local = EnvironmentId.make("env-local");
const remote = EnvironmentId.make("env-remote");
const thread = ThreadId.make("thread-specialist");

describe("fleetSeatAddress", () => {
  it("treats a remote child as a seat on its environment", () => {
    expect(
      fleetSeatFromRemoteChild({
        environmentId: remote,
        threadId: thread,
      }),
    ).toEqual(fleetSeatAddress(remote, thread));
  });
});

describe("resolveFleetSeatAddressability", () => {
  it.each([
    ["connected", "ready"],
    ["connecting", "connecting"],
    ["reconnecting", "connecting"],
    ["available", "unavailable"],
    ["offline", "unavailable"],
    ["error", "unavailable"],
    ["unsupported", "unavailable"],
  ] as const satisfies ReadonlyArray<readonly [EnvironmentConnectionPhase, string]>)(
    "maps connection phase %s to %s",
    (phase, expected) => {
      expect(resolveFleetSeatAddressability({ connection: { phase } })).toBe(expected);
    },
  );

  it("is unavailable when the environment is not registered on this client", () => {
    expect(resolveFleetSeatAddressability({ connection: null })).toBe("unavailable");
  });
});

describe("fleetSeatCommandTarget", () => {
  it("routes the command to the seat environment, not the viewing environment", () => {
    const seat = fleetSeatAddress(remote, thread);
    const input = fleetQueueCreateTurnInput({
      seat,
      message: { messageId: MessageId.make("msg-1"), text: "Check the failing test" },
      runtimeMode: "full-access",
      interactionMode: "default",
    });

    expect(fleetSeatCommandTarget(seat, input)).toEqual({
      environmentId: remote,
      input: {
        threadId: thread,
        message: {
          messageId: MessageId.make("msg-1"),
          role: "user",
          text: "Check the failing test",
          attachments: [],
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        dispatchMode: "queue",
      },
    });
    expect(fleetSeatCommandTarget(seat, input).environmentId).not.toBe(local);
  });
});

describe("fleetSeatAddressabilityHint", () => {
  it.each([
    ["ready", "Addressable on Box."],
    ["connecting", "Connecting to Box…"],
    ["unavailable", "Connect to Box to address this seat from here."],
  ] as const)("explains %s", (addressability, hint) => {
    expect(fleetSeatAddressabilityHint(addressability, "Box")).toBe(hint);
  });
});
