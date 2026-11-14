import { fileURLToPath } from "node:url";
import { expect, it } from "@alchemy.run/test";
import * as BunServices from "@effect/platform-bun/BunServices";
import * as Effect from "effect/Effect";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

const selection = Schema.fromJsonString(
  Schema.Struct({
    command: Schema.Array(Schema.String),
    cwd: Schema.String,
    external: Schema.Boolean,
    resetShared: Schema.Boolean,
    endpoint: Schema.String,
  }),
);

const invoke = Effect.fn(function* (args: string[], env: Record<string, string> = {}) {
  const script = yield* Effect.sync(() =>
    fileURLToPath(new URL("../../../../scripts/test-aws-floci.ts", import.meta.url)),
  );
  // The launcher runs on Node; resolve it here because the child gets an
  // empty PATH.
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const executable = (yield* spawner.string(
    ChildProcess.make("node", ["-p", "process.execPath"]),
  )).trim();
  const child = yield* ChildProcess.make(executable, [script, ...args], {
    env: {
      PATH: "",
      AWS_ENDPOINT_URL: "http://localhost:4566",
      ALCHEMY_FLOCI_EXTERNAL: "",
      ALCHEMY_FLOCI_NO_RESET: "",
      ...env,
    },
    extendEnv: false,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    killSignal: "SIGTERM",
    forceKillAfter: "1 second",
  });
  return yield* Effect.all(
    {
      code: child.exitCode,
      stdout: child.stdout.pipe(
        Stream.decodeText,
        Stream.runCollect,
        Effect.map((chunks) => chunks.join("")),
      ),
      stderr: child.stderr.pipe(
        Stream.decodeText,
        Stream.runCollect,
        Effect.map((chunks) => chunks.join("")),
      ),
    },
    { concurrency: "unbounded" },
  );
});

const dryRun = Effect.fn(function* (args: string[] = [], env: Record<string, string> = {}) {
  const result = yield* invoke(["--dry-run", ...args], env);
  expect(result.code).toBe(0);
  return yield* Schema.decodeUnknownEffect(selection)(result.stdout);
});

it.live(
  "Floci dry run preserves state and defaults to four concurrent files without Docker",
  () =>
    Effect.gen(function* () {
      const plan = yield* dryRun();
      expect(plan.resetShared).toBe(false);
      expect(plan.external).toBe(false);
      expect(plan.command.slice(-4)).toEqual(["--concurrency", "4", "--profile", "testing"]);
      expect(plan.command).toContain("test/AWS/Organizations/Organization.test.ts");
      // The Organizations suites share the account's one organization
      // through OrganizationLease, so the whole folder is selected.
      expect(plan.command).toContain("test/AWS/Organizations/Account.test.ts");
      expect(plan.command.some((arg) => arg.endsWith(".local.test.ts"))).toBe(false);
    }).pipe(Effect.provide(BunServices.layer)),
  { tags: ["unit", "local"] },
);

it.live(
  "Floci launcher preserves explicit concurrency and profile flag forms",
  () =>
    Effect.gen(function* () {
      for (const flags of [["--concurrency", "2"], ["--concurrency=2"], ["-c", "2"]]) {
        const plan = yield* dryRun([...flags, "--profile=testing"]);
        expect(plan.command.slice(-flags.length - 1)).toEqual([...flags, "--profile=testing"]);
        expect(plan.command).not.toContain("4");
        expect(plan.command).not.toContain("--profile");
      }
    }).pipe(Effect.provide(BunServices.layer)),
  { tags: ["unit", "local"] },
);

it.live(
  "Floci shared reset requires an explicit flag and rejects safety conflicts",
  () =>
    Effect.gen(function* () {
      expect((yield* dryRun(["--reset-shared"])).resetShared).toBe(true);
      for (const [args, env] of [
        [["--reset-shared", "--external"], {}],
        [["--reset-shared"], { ALCHEMY_FLOCI_EXTERNAL: "1" }],
        [["--reset-shared"], { ALCHEMY_FLOCI_NO_RESET: "1" }],
      ] as const) {
        const result = yield* invoke(["--dry-run", ...args], env);
        expect(result.code).toBe(1);
        expect(result.stderr).toContain("--reset-shared conflicts");
      }
    }).pipe(Effect.provide(BunServices.layer)),
  { tags: ["unit", "local"] },
);

it.live(
  "Floci external mode is selected by flag or environment without resetting",
  () =>
    Effect.gen(function* () {
      for (const plan of [
        yield* dryRun(["--external"]),
        yield* dryRun([], { ALCHEMY_FLOCI_EXTERNAL: "1" }),
      ]) {
        expect(plan.external).toBe(true);
        expect(plan.resetShared).toBe(false);
        expect(plan.command).not.toContain("--external");
        expect(plan.command).not.toContain("--dry-run");
      }
    }).pipe(Effect.provide(BunServices.layer)),
  { tags: ["unit", "local"] },
);

it.live(
  "Floci rejects mismatched gateways and normalizes the loopback alias",
  () =>
    Effect.gen(function* () {
      for (const endpoint of [
        "not a URL",
        "http://127.0.0.1:1",
        "http://localhost:4567",
        "https://localhost:4566",
        "http://localhost:4566/path",
        "http://localhost:4566/?query=1",
        "http://localhost:4566/#fragment",
        "http://user:password@localhost:4566",
      ]) {
        const result = yield* invoke(["--dry-run"], {
          AWS_ENDPOINT_URL: endpoint,
        });
        expect(result.code).toBe(1);
        expect(result.stderr).toContain("AWS_ENDPOINT_URL must be http://localhost:4566");
      }
      expect((yield* dryRun([], { AWS_ENDPOINT_URL: "http://127.0.0.1:4566/" })).endpoint).toBe(
        "http://localhost:4566",
      );
      const listed = yield* invoke(["--list", "test/AWS/SSM/Parameter.test.ts"]);
      expect(listed.code).toBe(0);
      expect(listed.stdout.trim()).toBe("test/AWS/SSM/Parameter.test.ts");
    }).pipe(Effect.provide(BunServices.layer)),
  { tags: ["unit", "local"] },
);
