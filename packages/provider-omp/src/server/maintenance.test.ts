import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { resolvePackageManagedProviderMaintenance } from "@t3tools/provider-core/server/maintenanceResolver";
import { ompMaintenanceDefinition } from "./maintenance.ts";

it.effect.each([
  {
    resolved: "/home/test/.bun/bin/omp",
    real: "/home/test/.bun/bin/omp",
    args: ["update"],
    executable: "/home/test/.bun/bin/omp",
  },
  {
    resolved: "/usr/local/bin/omp",
    real: "/usr/local/lib/node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js",
    args: [
      "install",
      "-g",
      "--prefix",
      "/usr/local",
      "--allow-scripts=@oh-my-pi/pi-coding-agent",
      "@oh-my-pi/pi-coding-agent@latest",
    ],
    executable: "npm",
  },
])("resolves the OMP install owner without launching an update: $resolved", (fixture) =>
  Effect.gen(function* () {
    const capabilities = yield* resolvePackageManagedProviderMaintenance(ompMaintenanceDefinition, {
      binaryPath: fixture.resolved,
      resolvedCommandPath: fixture.resolved,
      realCommandPath: fixture.real,
      env: {},
      platform: "darwin",
    });
    expect(capabilities.packageName).toBe("@oh-my-pi/pi-coding-agent");
    expect(capabilities.update?.executable).toBe(fixture.executable);
    expect(capabilities.update?.args).toEqual(fixture.args);
  }).pipe(
    Effect.provide(NodeServices.layer),
    Effect.provideService(
      ChildProcessSpawner.ChildProcessSpawner,
      ChildProcessSpawner.make(() => Effect.die("Resolver must not run an update")),
    ),
  ),
);
