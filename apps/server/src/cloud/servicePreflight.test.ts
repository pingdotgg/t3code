import { expect, it } from "@effect/vitest";

import { runServicePreflight } from "./servicePreflight.ts";

it.each([1])("blocks legacy launcher protocol %i", (launcherProtocol) => {
  expect(
    runServicePreflight({
      databasePath: "/missing/state.sqlite",
      launcherProtocol,
      version: "1.2.3",
    }),
  ).toEqual({
    status: "blocked",
    version: "1.2.3",
    reason:
      "This release requires a newer T3 Code service launcher. Update it on the server machine.",
  });
});
