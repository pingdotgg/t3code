import { expect, it } from "@effect/vitest";
import { SourceControlProviderKind, VcsProcessSpawnError } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { SpawnExecutableResolution } from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";
import * as PlatformError from "effect/PlatformError";

import { probeSourceControlProvider, providerAuth } from "./discovery.ts";

const installHint = "Install GitHub CLI.";
const badArchitecture = Object.assign(new Error("spawn Unknown system error -86"), {
  errno: -86,
  syscall: "spawn",
});

const probe = (cause: unknown, platform: NodeJS.Platform = "darwin") =>
  probeSourceControlProvider({
    cwd: "/repo",
    process: {
      run: (input) =>
        Effect.fail(
          new VcsProcessSpawnError({
            operation: input.operation,
            command: input.command,
            cwd: input.cwd,
            cause,
          }),
        ),
    },
    spec: {
      type: "cli",
      kind: SourceControlProviderKind.make("github"),
      label: "GitHub",
      executable: "gh",
      versionArgs: ["--version"],
      authArgs: ["auth", "status"],
      installHint,
      parseAuth: () => providerAuth({ status: "authenticated" }),
    },
  }).pipe(
    Effect.provideService(HostProcess.Platform, platform),
    Effect.provideService(HostProcess.Architecture, "arm64"),
    Effect.provideService(SpawnExecutableResolution, () => "/usr/local/bin/gh"),
  );

it.effect.each([
  { name: "synchronous errno", cause: badArchitecture },
  {
    name: "symbolic error code",
    cause: Object.assign(new Error("bad CPU type in executable"), { code: "EBADARCH" }),
  },
  {
    name: "platform-wrapped errno",
    cause: PlatformError.systemError({
      _tag: "Unknown",
      module: "ChildProcess",
      method: "spawn",
      pathOrDescriptor: "gh --version",
      cause: badArchitecture,
    }),
  },
])("reports the incompatible executable for $name", ({ cause }) =>
  Effect.gen(function* () {
    const item = yield* probe(cause);
    expect(item.status).toBe("missing");
    expect(item.auth.status).toBe("unknown");
    expect(item.installHint).toContain("/usr/local/bin/gh");
    expect(item.installHint).toContain("incompatible CPU architecture");
    expect(item.installHint).toContain("arm64");
    expect(item.installHint).toContain(installHint);
  }),
);

it.effect("does not interpret another platform's errno as a macOS architecture error", () =>
  Effect.gen(function* () {
    const item = yield* probe(badArchitecture, "linux");
    expect(item.installHint).toBe(installHint);
  }),
);

it.effect.each([
  new Error("gh not found"),
  Object.assign(new Error("permission denied"), { errno: -13, code: "EACCES" }),
])("keeps the ordinary install hint for other spawn failures: %s", (cause) =>
  Effect.gen(function* () {
    const item = yield* probe(cause);
    expect(item.status).toBe("missing");
    expect(item.installHint).toBe(installHint);
  }),
);
