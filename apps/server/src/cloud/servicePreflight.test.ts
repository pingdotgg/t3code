import { expect, it } from "@effect/vitest";

import {
  decodeServicePreflightResult,
  EMPTY_COLLAB_WAIT_RECOVERY_PROTOCOL,
  EMPTY_COLLAB_WAIT_RECOVERY_REQUIRED_REASON,
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
    emptyCollabWaitRecoveryProtocol: EMPTY_COLLAB_WAIT_RECOVERY_PROTOCOL,
  });
});

it("blocks a candidate that would remove empty collaboration-wait recovery", () => {
  expect(
    decodeServicePreflightResult({
      status: "ready",
      version: "1.2.4",
      launcherProtocol: SERVICE_LAUNCHER_PROTOCOL,
    }),
  ).toEqual({
    status: "blocked",
    version: "1.2.4",
    reason: EMPTY_COLLAB_WAIT_RECOVERY_REQUIRED_REASON,
  });
});
