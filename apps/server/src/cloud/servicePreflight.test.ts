import { expect, it } from "@effect/vitest";

import { runServicePreflight } from "./servicePreflight.ts";
import { SERVICE_LAUNCHER_PROTOCOL } from "./serviceProtocol.ts";

it("requires the database-snapshot launcher protocol", async () => {
  await expect(
    runServicePreflight({
      databasePath: "/missing/state.sqlite",
      launcherProtocol: SERVICE_LAUNCHER_PROTOCOL - 1,
      version: "1.2.3",
    }),
  ).resolves.toMatchObject({ status: "blocked", version: "1.2.3" });

  await expect(
    runServicePreflight({
      databasePath: "/missing/state.sqlite",
      launcherProtocol: SERVICE_LAUNCHER_PROTOCOL,
      version: "1.2.3",
    }),
  ).resolves.toEqual({
    status: "ready",
    version: "1.2.3",
    launcherProtocol: SERVICE_LAUNCHER_PROTOCOL,
  });
});

it("blocks a runtime whose node-pty does not load", async () => {
  const result = await runServicePreflight(
    { databasePath: "/missing/state.sqlite", launcherProtocol: SERVICE_LAUNCHER_PROTOCOL },
    () => Promise.reject(new Error("Cannot find module 'pty.node'")),
  );

  expect(result).toMatchObject({ status: "blocked" });
  expect(result.status === "blocked" && result.reason).toContain("Cannot find module 'pty.node'");
});
