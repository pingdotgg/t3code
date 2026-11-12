import {
  SourceControlProviderKind,
  type VcsError,
  VcsProcessExitError,
  VcsProcessSpawnError,
  VcsProcessTimeoutError,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import {
  providerAuth,
  type SourceControlProviderDiscoverySpec,
} from "@t3tools/source-control-core/server/discovery";
import type * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";
import {
  fakeDiscovery,
  fakeSourceControlProvider,
} from "@t3tools/source-control-testing/fakeSourceControlDriver";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { SpawnExecutableResolution } from "@t3tools/shared/shell";
import * as TestSourceControlHost from "@t3tools/source-control-testing/TestSourceControlHost";

import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as SourceControlDiscovery from "./SourceControlDiscovery.ts";
import * as SourceControlProviderRegistry from "./SourceControlProviderRegistry.ts";

const kind = SourceControlProviderKind.make;

// Serves both the host's runs and the server's own VCS probes, whose inputs share these fields.
const run = (
  input: Pick<
    SourceControlHost.SourceControlProcessInput,
    "operation" | "command" | "args" | "cwd"
  >,
): Effect.Effect<SourceControlHost.SourceControlProcessOutput, VcsError> => {
  const context = { operation: input.operation, command: input.command, cwd: input.cwd };
  if (input.command === "slow-cli") {
    return Effect.fail(new VcsProcessTimeoutError({ ...context, timeoutMs: 5_000 }));
  }
  if (input.command === "broken-cli") {
    return Effect.fail(
      new VcsProcessExitError({ ...context, exitCode: 1, detail: "broken-cli: bad install" }),
    );
  }
  if (input.command === "absent-cli") {
    return Effect.fail(
      new VcsProcessSpawnError({
        ...context,
        cause: PlatformError.systemError({
          _tag: "NotFound",
          module: "ChildProcess",
          method: "spawn",
          pathOrDescriptor: input.command,
        }),
      }),
    );
  }
  if (input.args[0] === "--version") {
    return input.command === "missing-cli"
      ? Effect.fail(
          new VcsProcessSpawnError({
            operation: input.operation,
            command: input.command,
            cwd: input.cwd,
            cause: new Error(`${input.command} not found`),
          }),
        )
      : Effect.succeed(TestSourceControlHost.processOutput(`${input.command} version test\n`));
  }
  return Effect.succeed(
    TestSourceControlHost.processOutput(`signed in as ${input.command}-user\n`),
  );
};

const cliDiscovery = (
  name: string,
  executable = name === "beta" ? "missing-cli" : `${name}-cli`,
) => ({
  type: "cli" as const,
  kind: kind(name),
  label: name,
  installHint: `Install ${name}.`,
  executable,
  versionArgs: ["--version"],
  authArgs: ["auth", "status"],
  parseAuth: ({ stdout }: { readonly stdout: string }) =>
    providerAuth({ status: "authenticated", account: /as (\S+)/.exec(stdout)?.[1] }),
});

const defaultDiscoveries = [
  cliDiscovery("alpha"),
  cliDiscovery("beta"),
  fakeDiscovery("gamma", {
    probeAuth: Effect.succeed(providerAuth({ status: "authenticated", account: "api-user" })),
  }),
];

const layerDiscovery = (
  runProcess = run,
  discoveries: ReadonlyArray<SourceControlProviderDiscoverySpec> = defaultDiscoveries,
) =>
  Layer.effect(
    SourceControlProviderRegistry.SourceControlProviderRegistry,
    SourceControlProviderRegistry.makeWithProviders(
      discoveries.map((discovery) => ({
        kind: discovery.kind,
        provider: fakeSourceControlProvider(discovery.kind),
        discovery,
      })),
    ),
  ).pipe(
    Layer.provideMerge(TestSourceControlHost.layer({ process: { run: runProcess } })),
    Layer.provideMerge(ServerSettings.ServerSettingsService.layerTest()),
    Layer.provideMerge(Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({})),
    Layer.provideMerge(Layer.mock(VcsProcess.VcsProcess)({ run: runProcess })),
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-source-control-discovery-" }),
    ),
    Layer.provideMerge(NodeServices.layer),
  );

it.effect("reports every hosting integration in registry order with its sign-in", () =>
  Effect.gen(function* () {
    const discovery = yield* SourceControlDiscovery.SourceControlDiscovery;
    const result = yield* discovery.discover;

    assert.deepStrictEqual(
      result.sourceControlProviders.map((item) => ({
        kind: item.kind,
        status: item.status,
        version: item.version,
        auth: item.auth.status,
        account: item.auth.account,
      })),
      [
        {
          kind: kind("alpha"),
          status: "available",
          version: Option.some("alpha-cli version test"),
          auth: "authenticated",
          account: Option.some("alpha-cli-user"),
        },
        {
          kind: kind("beta"),
          status: "missing",
          version: Option.none(),
          auth: "unknown",
          account: Option.none(),
        },
        {
          kind: kind("gamma"),
          status: "available",
          version: Option.none(),
          auth: "authenticated",
          account: Option.some("api-user"),
        },
      ],
    );
    assert.deepStrictEqual(
      result.versionControlSystems.map((item) => [item.kind, item.status]),
      [
        ["git", "available"],
        ["jj", "available"],
      ],
    );
  }).pipe(Effect.provide(SourceControlDiscovery.layer.pipe(Layer.provide(layerDiscovery())))),
);

it.effect("explains a hosting CLI whose version probe failed instead of advising an install", () =>
  Effect.gen(function* () {
    const discovery = yield* SourceControlDiscovery.SourceControlDiscovery;
    const result = yield* discovery.discover;
    const item = (name: string) => {
      const found = result.sourceControlProviders.find((entry) => entry.kind === kind(name));
      assert.isDefined(found);
      return found;
    };
    const authDetail = (name: string) => Option.getOrElse(item(name).auth.detail, () => "");

    assert.notInclude(item("slow").installHint, "Install slow.");
    assert.include(item("slow").installHint, "timed out after 5000ms");
    assert.strictEqual(authDetail("slow"), item("slow").installHint);

    assert.notInclude(item("broken").installHint, "Install broken.");
    assert.include(item("broken").installHint, "exited with status 1");
    assert.strictEqual(authDetail("broken"), item("broken").installHint);

    assert.strictEqual(item("absent").installHint, "Install absent.");
  }).pipe(
    Effect.provide(
      SourceControlDiscovery.layer.pipe(
        Layer.provide(
          layerDiscovery(run, [
            cliDiscovery("slow", "slow-cli"),
            cliDiscovery("broken", "broken-cli"),
            cliDiscovery("absent", "absent-cli"),
          ]),
        ),
      ),
    ),
  ),
);

it.effect.each(["darwin", "linux"] as const)(
  "names incompatible executables only on macOS (%s)",
  (platform) => {
    const runProcess: typeof run = (input) =>
      Effect.fail(
        new VcsProcessSpawnError({
          operation: input.operation,
          command: input.command,
          cwd: input.cwd,
          cause:
            input.command === "missing-cli"
              ? new Error("not found")
              : Object.assign(new Error("spawn Unknown system error -86"), { errno: -86 }),
        }),
      );
    return Effect.gen(function* () {
      const discovery = yield* SourceControlDiscovery.SourceControlDiscovery;
      const result = yield* discovery.discover;
      for (const item of [...result.versionControlSystems, ...result.sourceControlProviders]) {
        if (item.kind === kind("gamma")) continue;
        assert.strictEqual(item.status, "missing");
        if (platform === "darwin" && item.executable !== "missing-cli") {
          assert.include(
            item.installHint,
            `\`/usr/local/bin/${item.executable}\` is built for another CPU architecture, so this arm64 machine cannot run it. Remove or replace it.`,
          );
        } else {
          assert.notInclude(item.installHint, "CPU architecture");
        }
      }
    }).pipe(
      Effect.provide(SourceControlDiscovery.layer.pipe(Layer.provide(layerDiscovery(runProcess)))),
      Effect.provideService(SpawnExecutableResolution, (command) => `/usr/local/bin/${command}`),
      Effect.provideService(HostProcess.Platform, platform),
      Effect.provideService(HostProcess.Architecture, "arm64"),
    );
  },
);

// Spawns a real login shell and `jj`, so it runs on wall-clock time; the fixture shell is POSIX sh.
it.live.skipIf(HostProcess.Platform.defaultValue() === "win32")(
  "rescans with tools the login shell gained after the server started",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-discovery-login-shell-" });
      const home = path.join(root, "home");
      const fakebin = path.join(home, "fakebin");
      const loginShell = path.join(root, "loginsh");
      yield* fs.makeDirectory(fakebin, { recursive: true });
      // Stands in for `$SHELL -ilc <capture>` and sources only the fixture
      // profile, so the host's own shell init cannot change the result.
      yield* fs.writeFileString(
        loginShell,
        `#!/bin/sh\nexport HOME=${home}\n. "$HOME/.profile"\nshift\nexec /bin/sh -c "$1"\n`,
        { mode: 0o755 },
      );
      const env = yield* HostProcess.Environment;
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          const saved = { PATH: env.PATH, SHELL: env.SHELL };
          env.SHELL = loginShell;
          return saved;
        }),
        (saved) =>
          Effect.sync(() => {
            env.PATH = saved.PATH;
            if (saved.SHELL === undefined) delete env.SHELL;
            else env.SHELL = saved.SHELL;
          }),
      );

      // The user installs a tool after launch; their login shell now finds it.
      yield* fs.writeFileString(path.join(fakebin, "jj"), "#!/bin/sh\necho 'jj 0.99.0-test'\n", {
        mode: 0o755,
      });
      yield* fs.writeFileString(path.join(home, ".profile"), 'export PATH="$HOME/fakebin:$PATH"\n');

      const discovery = yield* SourceControlDiscovery.SourceControlDiscovery;
      const jj = (yield* discovery.discover).versionControlSystems.find(
        (item) => item.kind === "jj",
      );

      assert.deepStrictEqual(
        { status: jj?.status, version: jj?.version },
        { status: "available", version: Option.some("jj 0.99.0-test") },
      );
    }).pipe(
      Effect.scoped,
      Effect.provide(
        SourceControlDiscovery.layer.pipe(
          Layer.provide(VcsProcess.layer),
          Layer.provideMerge(layerDiscovery()),
        ),
      ),
    ),
);
