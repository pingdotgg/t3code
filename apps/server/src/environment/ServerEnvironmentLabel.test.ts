import { assert, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import * as ProcessRunner from "../processRunner.ts";
import { resolveServerEnvironmentLabel } from "./ServerEnvironmentLabel.ts";

const labelFromMachineInfo = (machineInfo: string) =>
  resolveServerEnvironmentLabel({ cwdBaseName: "project" }).pipe(
    Effect.provideService(HostProcess.Platform, "linux"),
    Effect.provide(
      Layer.mergeAll(
        FileSystem.layerNoop({
          exists: () => Effect.succeed(true),
          readFileString: () => Effect.succeed(machineInfo),
        }),
        Layer.mock(ProcessRunner.ProcessRunner)({
          run: () => Effect.die("hostnamectl should not run when machine-info names the host"),
        }),
      ),
    ),
  );

it.effect("reads the pretty hostname systemd quoted with shell escapes", () =>
  Effect.gen(function* () {
    // hostnamed escapes ", \, ` and $ inside the double quotes it writes.
    const label = yield* labelFromMachineInfo(
      'PRETTY_HOSTNAME="Marco\'s \\"Work\\" \\$erver \\\\ \\`lab\\`"\n',
    );
    assert.equal(label, 'Marco\'s "Work" $erver \\ `lab`');
  }),
);

it.effect("keeps single-quoted and unquoted pretty hostnames as written", () =>
  Effect.gen(function* () {
    assert.equal(yield* labelFromMachineInfo("PRETTY_HOSTNAME='C:\\dev box'\n"), "C:\\dev box");
    assert.equal(yield* labelFromMachineInfo("PRETTY_HOSTNAME=devbox\n"), "devbox");
  }),
);
