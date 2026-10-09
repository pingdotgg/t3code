import { expect, it } from "@effect/vitest";

import { runServicePreflight } from "./servicePreflight.ts";
import { SERVICE_LAUNCHER_PROTOCOL } from "./serviceProtocol.ts";

it.each([1, 2])("blocks legacy launcher protocol %i", (launcherProtocol) => {
  const result = runServicePreflight({
    databasePath: "/missing/state.sqlite",
    launcherProtocol,
    version: "1.2.3",
  });
  expect(result).toMatchObject({ status: "blocked", version: "1.2.3" });
  const reason = result.status === "blocked" ? result.reason : "";
  expect(reason).toContain(`needs service launcher protocol ${SERVICE_LAUNCHER_PROTOCOL}`);
  expect(reason).toContain(`offered protocol ${launcherProtocol}`);
  expect(reason).toContain("T3CODE_VERSION=1.2.3 sh");
  expect(reason).toContain("`t3 service install`");
  expect(reason).toContain("`which -a t3`");
});

it("accepts the current launcher protocol", () => {
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
  });
});
