import { expect, it } from "@effect/vitest";

import {
  decodeServicePreflightResult,
  EMPTY_COLLAB_WAIT_RECOVERY_PROTOCOL,
  EMPTY_COLLAB_WAIT_RECOVERY_REQUIRED_REASON,
  PENDING_TURN_RECOVERY_PROTOCOL,
  PENDING_TURN_RECOVERY_REQUIRED_REASON,
  PROVIDER_LIFECYCLE_RECOVERY_PROTOCOL,
  PROVIDER_LIFECYCLE_RECOVERY_REQUIRED_REASON,
  runServicePreflight,
} from "./servicePreflight.ts";
import { SERVICE_LAUNCHER_PROTOCOL } from "./serviceProtocol.ts";

it("requires the database-snapshot launcher protocol", () => {
  expect(
    runServicePreflight({
      databasePath: "/missing/state.sqlite",
      launcherProtocol: SERVICE_LAUNCHER_PROTOCOL - 1,
      version: "1.2.3",
    }),
  ).toMatchObject({ status: "blocked", version: "1.2.3" });

  expect(
    runServicePreflight({
      databasePath: "/missing/state.sqlite",
      launcherProtocol: SERVICE_LAUNCHER_PROTOCOL,
      version: "1.2.3",
    }),
  ).toEqual({
    status: "ready",
    version: "1.2.3",
    launcherProtocol: SERVICE_LAUNCHER_PROTOCOL,
    providerLifecycleRecoveryProtocol: PROVIDER_LIFECYCLE_RECOVERY_PROTOCOL,
    emptyCollabWaitRecoveryProtocol: EMPTY_COLLAB_WAIT_RECOVERY_PROTOCOL,
    pendingTurnRecoveryProtocol: PENDING_TURN_RECOVERY_PROTOCOL,
  });
});

it("blocks a candidate that would remove durable pending-turn recovery", () => {
  expect(
    decodeServicePreflightResult({
      status: "ready",
      version: "1.2.4",
      launcherProtocol: SERVICE_LAUNCHER_PROTOCOL,
      providerLifecycleRecoveryProtocol: PROVIDER_LIFECYCLE_RECOVERY_PROTOCOL,
      emptyCollabWaitRecoveryProtocol: EMPTY_COLLAB_WAIT_RECOVERY_PROTOCOL,
    }),
  ).toEqual({
    status: "blocked",
    version: "1.2.4",
    reason: PENDING_TURN_RECOVERY_REQUIRED_REASON,
  });
});

it("blocks protocol two because stale recovery can still erase a newer pending request", () => {
  expect(
    decodeServicePreflightResult({
      status: "ready",
      version: "1.2.4",
      launcherProtocol: SERVICE_LAUNCHER_PROTOCOL,
      providerLifecycleRecoveryProtocol: PROVIDER_LIFECYCLE_RECOVERY_PROTOCOL,
      pendingTurnRecoveryProtocol: 2,
    }),
  ).toEqual({
    status: "blocked",
    version: "1.2.4",
    reason: PENDING_TURN_RECOVERY_REQUIRED_REASON,
  });
});

it("blocks a candidate that would remove automatic provider lifecycle recovery", () => {
  expect(
    decodeServicePreflightResult({
      status: "ready",
      version: "1.2.4",
      launcherProtocol: SERVICE_LAUNCHER_PROTOCOL,
    }),
  ).toEqual({
    status: "blocked",
    version: "1.2.4",
    reason: PROVIDER_LIFECYCLE_RECOVERY_REQUIRED_REASON,
  });
});

it("blocks a candidate that would remove empty collaboration-wait recovery", () => {
  expect(
    decodeServicePreflightResult({
      status: "ready",
      version: "1.2.4",
      launcherProtocol: SERVICE_LAUNCHER_PROTOCOL,
      providerLifecycleRecoveryProtocol: PROVIDER_LIFECYCLE_RECOVERY_PROTOCOL,
      pendingTurnRecoveryProtocol: PENDING_TURN_RECOVERY_PROTOCOL,
    }),
  ).toEqual({
    status: "blocked",
    version: "1.2.4",
    reason: EMPTY_COLLAB_WAIT_RECOVERY_REQUIRED_REASON,
  });
});
