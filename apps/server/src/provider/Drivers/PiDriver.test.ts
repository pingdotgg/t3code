// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";

import { ProviderInstanceId } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";

import { resolvePiSessionDirectory } from "./PiDriver.ts";

it("isolates native Pi session storage by runtime instance", () => {
  expect(
    resolvePiSessionDirectory({
      stateDir: "/tmp/t3/userdata",
      instanceId: ProviderInstanceId.make("pi_personal"),
      join: NodePath.join,
    }),
  ).toBe("/tmp/t3/userdata/pi-sessions/pi_personal");
  expect(
    resolvePiSessionDirectory({
      stateDir: "/tmp/t3/userdata",
      instanceId: ProviderInstanceId.make("pi_work"),
      join: NodePath.join,
    }),
  ).toBe("/tmp/t3/userdata/pi-sessions/pi_work");
});
