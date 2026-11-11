import { fileURLToPath } from "node:url";
import * as AWS from "@alchemy.run/aws";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Logs from "@distilled.cloud/aws/cloudwatch-logs";
import * as iam from "@distilled.cloud/aws/iam";
import * as Lambda from "@distilled.cloud/aws/lambda";
import { adopt } from "alchemy/AdoptPolicy";
import * as Drift from "alchemy/Drift";
import * as Output from "alchemy/Output";
import * as Provider from "alchemy/Provider";
import { State } from "alchemy/State";
import { zipCode } from "alchemy/Util/zip";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as HttpClient from "effect/http/HttpClient";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { cloneFixture } from "../../Cloudflare/Utils/Fixture.ts";
import { aliasFunction, AliasFunction } from "./fixtures/alias-handler.ts";
import { TestFunction, TestFunctionLive } from "./handler.ts";
import StreamingFunctionLive, { StreamingFunction } from "./streaming-handler.ts";

const asyncHandlerPath = fileURLToPath(new URL("./async-handler.ts", import.meta.url));
const namedHandlerPath = fileURLToPath(new URL("./named-handler.ts", import.meta.url));
const timeoutHandlerPath = fileURLToPath(new URL("./timeout-handler.ts", import.meta.url));
const externalPackageHandlerPath = fileURLToPath(
  new URL("./external-package-handler.ts", import.meta.url),
);
const lockfilePinnedHandlerPath = (format: "npm" | "bun" | "pnpm" | "yarn") =>
  fileURLToPath(new URL(`./fixtures/lockfile-pinning/${format}/handler.ts`, import.meta.url));

const { test } = Test.make({ providers: AWS.providers() });

test.provider(
  "create, update, delete function",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deploy = (marker: string) =>
        stack.deploy(
          Effect.gen(function* () {
            const fn = yield* TestFunction;
            yield* fn.bind`ReadinessMarker`({
              env: { READINESS_MARKER: marker, CONFIG_FLAG: "true", CONFIG_PORT: "3000" },
            });
            return fn;
          }).pipe(Effect.provide(TestFunctionLive)),
        );

      const { functionName, functionUrl, roleName } = yield* deploy("created");
      yield* assertFunctionReady(functionName, "created");
      // `Config.Boolean`/`Config.Number` decode JSON-looking env strings at runtime.
      expect(yield* invokeHttpFunction(functionName, "/config")).toBe("true 3000");

      const updated = yield* deploy("updated");
      expect(updated.functionName).toBe(functionName);
      yield* assertFunctionReady(updated.functionName, "updated");

      expect(functionUrl).toBeTruthy();

      const response = yield* HttpClient.get(functionUrl!).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? Effect.succeed(response)
            : Effect.fail(new Error(`Function URL returned ${response.status}`)),
        ),
        Effect.tapError((error) => Effect.logError(error)),
        Effect.retry({
          schedule: Schedule.max([Schedule.exponential(500), Schedule.recurs(10)]),
        }),
      );

      expect(response.status).toBe(200);
      expect(yield* response.text).toBe("Hello, world!");

      const invokePolicy = yield* getPolicyStatement(functionName, "FunctionURLAllowPublicInvoke");
      expect(invokePolicy.Condition).toEqual({
        Bool: {
          "lambda:InvokedViaFunctionUrl": "true",
        },
      });

      yield* stack.destroy();
      yield* assertFunctionDeleted(functionName);
      yield* assertRoleDeleted(roleName);

      const recreated = yield* deploy("recreated");
      yield* assertFunctionReady(recreated.functionName, "recreated");
      yield* stack.destroy();
      yield* assertFunctionDeleted(recreated.functionName);
      yield* assertRoleDeleted(recreated.roleName);
    }).pipe(
      Effect.tap(() => stack.destroy()),
      Effect.onError(() => stack.destroy().pipe(Effect.ignore)),
    ),
  {
    tags: ["provider:aws", "provider:aws:iam", "provider:aws:lambda", "live"],
    timeout: 180_000,
  },
);

// Pins the live diff's plan-time bundle hash. Dev mode (ALCHEMY_TEST_DEV=1)
// plans content-only changes as noop and hot-swaps them from the watch loop
// (covered by Function.local.test.ts), and the fixture's function-valued
// `build.external` cannot cross the dev sidecar's RPC boundary.
test.provider.skipIf(process.env.ALCHEMY_TEST_DEV === "1")(
  "Effect-native function updates when its source changes",
  (stack) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* stack.destroy();

      // Work on a temp copy so editing the source never touches the
      // checked-in fixture. The copy lives under packages/integration-tests/.tmp so its
      // imports resolve exactly like the original's.
      const fixtureDir = yield* cloneFixture(
        yield* path.fromFileUrl(new URL("./fixtures/source-change", import.meta.url)),
        {
          prefix: "alchemy-lambda-source-change-",
          tempRoot: yield* path.fromFileUrl(new URL("../../../.tmp", import.meta.url)),
        },
      );
      const entry = path.join(fixtureDir, "function.ts");
      const source = yield* fs.readFileString(entry);
      const fixture = yield* Effect.promise(
        () => import(entry) as Promise<typeof import("./fixtures/source-change/function.ts")>,
      );
      const declaration = fixture.SourceChangeFunction.pipe(
        Effect.provide(fixture.SourceChangeFunctionLive),
      );

      const created = yield* Effect.gen(function* () {
        const created = yield* stack.deploy(declaration);
        expect(yield* invokeHttpFunction(created.functionName)).toBe("source-v1");

        const unchanged = yield* stack.plan(declaration);
        expect(unchanged.resources.SourceChangeFunction).toMatchObject({
          action: "noop",
        });

        yield* fs.writeFileString(entry, source.replace('"source-v1"', '"source-v2"'));

        const changed = yield* stack.plan(declaration);
        expect(changed.resources.SourceChangeFunction).toMatchObject({
          action: "update",
        });

        const updated = yield* stack.deploy(declaration);
        expect(updated.functionName).toBe(created.functionName);
        expect(yield* invokeHttpFunction(updated.functionName)).toBe("source-v2");
        return created;
      }).pipe(Effect.ensuring(fs.remove(fixtureDir, { recursive: true }).pipe(Effect.ignore)));

      yield* stack.destroy();
      yield* assertFunctionDeleted(created.functionName);
      yield* assertRoleDeleted(created.roleName);
    }).pipe(Effect.onError(() => stack.destroy().pipe(Effect.ignore))),
  {
    tags: ["provider:aws", "provider:aws:iam", "provider:aws:lambda", "live"],
    timeout: 120_000,
  },
);

test.provider(
  "async handler invokes the default export",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const fn = yield* stack.deploy(
        AWS.Lambda.Function("AsyncHandlerFn", {
          main: asyncHandlerPath,
          functionUrl: false,
        }),
      );

      const { Configuration } = yield* Lambda.getFunction({ FunctionName: fn.functionName });
      expect(Configuration?.Handler).toBe("index.default");

      const response = yield* Lambda.invoke({ FunctionName: fn.functionName, Payload: "{}" });
      expect(response.FunctionError).toBeUndefined();
      const payload = response.Payload
        ? yield* response.Payload.pipe(Stream.decodeText(), Stream.mkString)
        : "";
      expect(JSON.parse(payload)).toEqual({ statusCode: 200, body: "ok" });

      yield* stack.destroy();
      yield* assertFunctionDeleted(fn.functionName);
      yield* assertRoleDeleted(fn.roleName);
    }).pipe(Effect.onError(() => stack.destroy().pipe(Effect.ignore))),
  {
    tags: ["provider:aws", "provider:aws:iam", "provider:aws:lambda", "live"],
    timeout: 120_000,
  },
);

test.provider(
  "async handler invokes the export named by `handler`",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const fn = yield* stack.deploy(
        AWS.Lambda.Function("NamedHandlerFn", {
          main: namedHandlerPath,
          handler: "handler",
          functionUrl: false,
        }),
      );

      const { Configuration } = yield* Lambda.getFunction({ FunctionName: fn.functionName });
      expect(Configuration?.Handler).toBe("index.handler");

      const response = yield* Lambda.invoke({ FunctionName: fn.functionName, Payload: "{}" });
      expect(response.FunctionError).toBeUndefined();
      const payload = response.Payload
        ? yield* response.Payload.pipe(Stream.decodeText(), Stream.mkString)
        : "";
      expect(JSON.parse(payload)).toEqual({ statusCode: 200, body: "named" });

      yield* stack.destroy();
      yield* assertFunctionDeleted(fn.functionName);
      yield* assertRoleDeleted(fn.roleName);
    }).pipe(Effect.onError(() => stack.destroy().pipe(Effect.ignore))),
  {
    tags: ["provider:aws", "provider:aws:iam", "provider:aws:lambda", "live"],
    timeout: 120_000,
  },
);

test.provider(
  "applies and updates the Lambda timeout",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const initial = yield* stack.deploy(
        AWS.Lambda.Function("TimeoutFn", {
          main: timeoutHandlerPath,
          handler: "handler",
          isExternal: true,
          functionUrl: false,
          timeout: Duration.seconds(15),
        }),
      );

      const initialConfig = yield* Lambda.getFunction({
        FunctionName: initial.functionName,
      });
      expect(initialConfig.Configuration?.Timeout).toBe(15);

      yield* stack.deploy(
        AWS.Lambda.Function("TimeoutFn", {
          main: timeoutHandlerPath,
          handler: "handler",
          isExternal: true,
          functionUrl: false,
          timeout: Duration.seconds(45),
        }),
      );

      const updatedConfig = yield* Lambda.getFunction({
        FunctionName: initial.functionName,
      }).pipe(
        Effect.filterOrFail(
          (c) => c.Configuration?.Timeout === 45,
          () => new Error("Timeout update has not propagated yet"),
        ),
        Effect.retry({
          schedule: Schedule.max([Schedule.exponential(500), Schedule.recurs(10)]),
        }),
      );
      expect(updatedConfig.Configuration?.Timeout).toBe(45);

      yield* stack.destroy();
      yield* assertFunctionDeleted(initial.functionName);
    }).pipe(
      Effect.tap(() => stack.destroy()),
      Effect.onError(() => stack.destroy().pipe(Effect.ignore)),
    ),
  { tags: ["provider:aws", "provider:aws:lambda", "live"], timeout: 360_000 },
);

// `logging.retention` makes Alchemy create the `/aws/lambda/<name>` log
// group up front (Lambda would only create it on first invoke, with no
// expiry) and keep its retention policy in sync; destroy reaps the group.
test.provider(
  "applies, updates, and clears log retention",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployWith = (retention: "10 days" | "forever") =>
        stack.deploy(
          AWS.Lambda.Function("RetentionFn", {
            main: timeoutHandlerPath,
            handler: "handler",
            isExternal: true,
            functionUrl: false,
            logging: { retention },
          }),
        );
      const describeGroup = (name: string) =>
        Logs.describeLogGroups({ logGroupNamePrefix: name }).pipe(
          Effect.map((r) => (r.logGroups ?? []).find((g) => g.logGroupName === name)),
        );

      // Never invoked: the group exists only because Alchemy created it.
      const fn = yield* deployWith("10 days");
      const logGroupName = `/aws/lambda/${fn.functionName}`;
      expect((yield* describeGroup(logGroupName))?.retentionInDays).toBe(14);

      yield* deployWith("forever");
      const cleared = yield* describeGroup(logGroupName);
      expect(cleared).toBeDefined();
      expect(cleared?.retentionInDays).toBeUndefined();

      yield* stack.destroy();
      yield* assertFunctionDeleted(fn.functionName);
      expect(yield* describeGroup(logGroupName)).toBeUndefined();
    }).pipe(Effect.onError(() => stack.destroy().pipe(Effect.ignore))),
  { tags: ["provider:aws", "provider:aws:lambda", "provider:aws:logs", "live"], timeout: 360_000 },
);

// Alchemy owns `/aws/lambda/<name>`: the execution role keeps the managed
// AWSLambdaBasicExecutionRole but is denied logs:CreateLogGroup on its own
// group, so destroy deletes the group exactly once — Lambda's asynchronous
// flush of an invocation that ran right before the delete is dropped instead
// of silently recreating the group.
test.provider(
  "destroy right after an invoke removes the log group for good",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const fn = yield* stack.deploy(
        AWS.Lambda.Function("FlushFn", {
          main: timeoutHandlerPath,
          handler: "handler",
          isExternal: true,
          functionUrl: false,
        }),
      );
      const logGroupName = `/aws/lambda/${fn.functionName}`;
      const describeGroup = Logs.describeLogGroups({ logGroupNamePrefix: logGroupName }).pipe(
        Effect.map((r) => (r.logGroups ?? []).find((g) => g.logGroupName === logGroupName)),
      );

      // Created by Alchemy before any invocation.
      expect(yield* describeGroup).toBeDefined();

      // The managed policy stays; an inline Deny scoped to this function's
      // group overrides its logs:CreateLogGroup on *.
      const attached = yield* iam.listAttachedRolePolicies({ RoleName: fn.roleName });
      expect((attached.AttachedPolicies ?? []).map((p) => p.PolicyArn)).toEqual([
        "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole",
      ]);
      const { PolicyDocument } = yield* iam.getRolePolicy({
        RoleName: fn.roleName,
        PolicyName: "AlchemyDenyLogGroupCreate",
      });
      const guard = JSON.parse(decodeURIComponent(PolicyDocument)) as {
        Statement: { Effect: string; Action: string; Resource: string }[];
      };
      expect(guard.Statement).toHaveLength(1);
      expect(guard.Statement[0]).toMatchObject({
        Effect: "Deny",
        Action: "logs:CreateLogGroup",
      });
      expect(guard.Statement[0]!.Resource).toMatch(
        new RegExp(`:log-group:${logGroupName.replaceAll("/", "\\/")}:\\*$`),
      );

      // Invocations whose log batches are still in flight at delete time.
      for (let i = 0; i < 3; i++) {
        const response = yield* Lambda.invoke({ FunctionName: fn.functionName, Payload: "{}" });
        expect(response.FunctionError).toBeUndefined();
      }

      const [elapsed] = yield* Effect.timed(stack.destroy());
      yield* Effect.logInfo(`destroy took ${Duration.format(elapsed)}`);
      // No flush window to wait out (previously ~40s+).
      expect(Duration.toSeconds(elapsed)).toBeLessThan(30);
      yield* assertFunctionDeleted(fn.functionName);
      yield* assertRoleDeleted(fn.roleName);
      expect(yield* describeGroup).toBeUndefined();

      // Lambda flushes the final batches up to ~35s after the last invoke;
      // the role could never create the group, so it stays gone.
      yield* Effect.sleep("60 seconds");
      expect(yield* describeGroup).toBeUndefined();
    }).pipe(Effect.onError(() => stack.destroy().pipe(Effect.ignore))),
  { tags: ["provider:aws", "provider:aws:lambda", "provider:aws:logs", "live"], timeout: 180_000 },
);

// Roles deployed by older Alchemy versions have no guard; the next deploy
// adds it (and creates the log group if Lambda never did).
test.provider(
  "adds the log-group guard to an existing role on the next deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deploy = (marker: string) =>
        stack.deploy(
          AWS.Lambda.Function("LegacyRoleFn", {
            main: timeoutHandlerPath,
            handler: "handler",
            isExternal: true,
            functionUrl: false,
            env: { MARKER: marker },
          }),
        );
      const fn = yield* deploy("v1");
      const logGroupName = `/aws/lambda/${fn.functionName}`;

      // Recreate the pre-guard shape out-of-band.
      yield* iam.deleteRolePolicy({
        RoleName: fn.roleName,
        PolicyName: "AlchemyDenyLogGroupCreate",
      });
      yield* Logs.deleteLogGroup({ logGroupName });

      yield* deploy("v2");

      const { PolicyNames } = yield* iam.listRolePolicies({ RoleName: fn.roleName });
      expect(PolicyNames).toContain("AlchemyDenyLogGroupCreate");
      const groups = yield* Logs.describeLogGroups({ logGroupNamePrefix: logGroupName });
      expect((groups.logGroups ?? []).map((g) => g.logGroupName)).toContain(logGroupName);

      yield* stack.destroy();
      yield* assertFunctionDeleted(fn.functionName);
      yield* assertRoleDeleted(fn.roleName);
    }).pipe(Effect.onError(() => stack.destroy().pipe(Effect.ignore))),
  { tags: ["provider:aws", "provider:aws:iam", "provider:aws:lambda", "live"], timeout: 120_000 },
);

test.provider(
  "installs explicit external packages into the deployment artifact",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { functionName, functionUrl } = yield* stack.deploy(
        AWS.Lambda.Function("InstallFn", {
          main: externalPackageHandlerPath,
          handler: "handler",
          isExternal: true,
          functionUrl: true,
          build: {
            install: ["uuid"],
          },
        }),
      );

      const response = yield* HttpClient.get(functionUrl!).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? Effect.succeed(response)
            : Effect.fail(new Error(`Function URL returned ${response.status}`)),
        ),
        Effect.retry({
          schedule: Schedule.max([Schedule.exponential(500), Schedule.recurs(10)]),
        }),
      );

      const body = JSON.parse(yield* response.text) as { id: string };
      expect(body.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );

      yield* stack.destroy();
      yield* assertFunctionDeleted(functionName);
    }).pipe(
      Effect.tap(() => stack.destroy()),
      Effect.onError(() => stack.destroy().pipe(Effect.ignore)),
    ),
  { tags: ["provider:aws", "provider:aws:lambda", "live"], timeout: 360_000 },
);

test.provider(
  "installs external packages at the versions pinned by each lockfile format",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // Each fixture project declares make-dir@^3.0.0 but its lockfile pins
      // make-dir@3.0.0 and its transitive semver@6.3.0 — both below the latest
      // versions satisfying their ranges (3.1.0 / 6.3.1). Free npm resolution
      // installs the newer versions, so the assertions below fail without
      // lockfile pinning. Legacy binary bun.lockb has no live fixture because
      // current Bun can only write the text format; its print-and-parse path
      // is covered by the yarn-v1 unit fixtures.
      const formats = ["npm", "bun", "pnpm", "yarn"] as const;
      const pinnedFunction = (format: (typeof formats)[number]) =>
        AWS.Lambda.Function(`LockfilePinnedFn-${format}`, {
          main: lockfilePinnedHandlerPath(format),
          handler: "handler",
          isExternal: true,
          functionUrl: true,
          build: {
            install: ["make-dir"],
          },
        });
      const deployed = yield* stack.deploy(
        Effect.all({
          npm: pinnedFunction("npm"),
          bun: pinnedFunction("bun"),
          pnpm: pinnedFunction("pnpm"),
          yarn: pinnedFunction("yarn"),
        }),
      );

      for (const format of formats) {
        const { functionUrl } = deployed[format];
        const response = yield* HttpClient.get(functionUrl!).pipe(
          Effect.flatMap((response) =>
            response.status === 200
              ? Effect.succeed(response)
              : Effect.fail(new Error(`Function URL returned ${response.status}`)),
          ),
          Effect.retry({
            schedule: Schedule.max([Schedule.exponential(500), Schedule.recurs(10)]),
          }),
        );

        const body = JSON.parse(yield* response.text) as {
          makeDir: string;
          semver: string;
        };
        expect(body.makeDir, format).toBe("3.0.0");
        expect(body.semver, format).toBe("6.3.0");
      }

      yield* stack.destroy();
      yield* assertFunctionDeleted(deployed.npm.functionName);
    }).pipe(
      Effect.tap(() => stack.destroy()),
      Effect.onError(() => stack.destroy().pipe(Effect.ignore)),
    ),
  { tags: ["provider:aws", "provider:aws:lambda", "live"], timeout: 360_000 },
);

test.provider(
  "applies and updates the Lambda architecture",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const initial = yield* stack.deploy(
        AWS.Lambda.Function("ArchitectureFn", {
          main: timeoutHandlerPath,
          handler: "handler",
          isExternal: true,
          functionUrl: false,
          architecture: "arm64",
        }),
      );

      yield* waitForArchitecture(initial.functionName, "arm64");

      const updated = yield* stack.deploy(
        AWS.Lambda.Function("ArchitectureFn", {
          main: timeoutHandlerPath,
          handler: "handler",
          isExternal: true,
          functionUrl: false,
        }),
      );

      expect(updated.functionName).toBe(initial.functionName);
      yield* waitForArchitecture(updated.functionName, "x86_64");

      yield* stack.destroy();
      yield* assertFunctionDeleted(initial.functionName);
    }).pipe(
      Effect.tap(() => stack.destroy()),
      Effect.onError(() => stack.destroy().pipe(Effect.ignore)),
    ),
  { tags: ["provider:aws", "provider:aws:lambda", "live"], timeout: 360_000 },
);

test.provider(
  "applies, updates, and removes reserved concurrency",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const initial = yield* stack.deploy(
        AWS.Lambda.Function("ConcurrencyFn", {
          main: timeoutHandlerPath,
          handler: "handler",
          isExternal: true,
          functionUrl: false,
        }),
      );

      expect(initial.reservedConcurrentExecutions).toBeUndefined();
      yield* waitForReservedConcurrency(initial.functionName, undefined);

      const updated = yield* stack.deploy(
        AWS.Lambda.Function("ConcurrencyFn", {
          main: timeoutHandlerPath,
          handler: "handler",
          isExternal: true,
          functionUrl: false,
          reservedConcurrentExecutions: 0,
        }),
      );

      expect(updated.functionName).toBe(initial.functionName);
      expect(updated.reservedConcurrentExecutions).toBe(0);
      yield* waitForReservedConcurrency(updated.functionName, 0);

      const removed = yield* stack.deploy(
        AWS.Lambda.Function("ConcurrencyFn", {
          main: timeoutHandlerPath,
          handler: "handler",
          isExternal: true,
          functionUrl: false,
        }),
      );

      expect(removed.functionName).toBe(initial.functionName);
      expect(removed.reservedConcurrentExecutions).toBeUndefined();
      yield* waitForReservedConcurrency(removed.functionName, undefined);

      yield* stack.destroy();
      yield* assertFunctionDeleted(initial.functionName);
    }).pipe(
      Effect.tap(() => stack.destroy()),
      Effect.onError(() => stack.destroy().pipe(Effect.ignore)),
    ),
  { tags: ["provider:aws", "provider:aws:lambda", "live"], timeout: 360_000 },
);

// #2435: `read` must observe the live configuration, or an out-of-band
// memory/timeout change reads as `unchanged` and drift never repairs it.
test.provider(
  "drift detects and repairs out-of-band memory and timeout changes",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const fn = yield* stack.deploy(
        AWS.Lambda.Function("DriftFn", {
          main: timeoutHandlerPath,
          handler: "handler",
          isExternal: true,
          functionUrl: false,
          memorySize: 128,
          timeout: Duration.seconds(3),
        }),
      );
      expect(fn.memorySize).toBe(128);
      expect(fn.timeoutSeconds).toBe(3);

      const detectDrift = () => Drift.detect(stack).pipe(Effect.provide(stack.state));
      expect((yield* detectDrift()).resources.DriftFn?.action).toBe("unchanged");

      yield* Lambda.updateFunctionConfiguration({
        FunctionName: fn.functionName,
        MemorySize: 256,
        Timeout: 10,
      }).pipe(
        Effect.retry({
          while: (e) => e._tag === "ResourceConflictException",
          schedule: Schedule.exponential(500),
          times: 8,
        }),
      );
      yield* waitForConfiguration(fn.functionName, { memorySize: 256, timeout: 10 });

      const drifted = (yield* detectDrift()).resources.DriftFn;
      expect(drifted?.action).toBe("drifted");
      expect(drifted?.attr).toMatchObject({ memorySize: 256, timeoutSeconds: 10 });

      const repaired = yield* Drift.repair({ name: stack.name, stage: stack.stage }).pipe(
        Effect.provide(stack.state),
      );
      expect(repaired.resources.DriftFn?.action).toBe("repaired");
      yield* waitForConfiguration(fn.functionName, { memorySize: 128, timeout: 3 });
      expect((yield* detectDrift()).resources.DriftFn?.action).toBe("unchanged");

      yield* stack.destroy();
      yield* assertFunctionDeleted(fn.functionName);
    }).pipe(Effect.onError(() => stack.destroy().pipe(Effect.ignore))),
  { tags: ["provider:aws", "provider:aws:lambda", "live"], timeout: 240_000 },
);

// `read` reports a function whose ownership tags were stripped as `Unowned`;
// drift repairs it anyway (state records it as ours). Repair must restore the
// configuration and the tags, not refuse on the missing tags.
test.provider(
  "drift repairs a function whose ownership tags were stripped",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const fn = yield* stack.deploy(
        AWS.Lambda.Function("DriftTagsFn", {
          main: timeoutHandlerPath,
          handler: "handler",
          isExternal: true,
          functionUrl: false,
          memorySize: 128,
          timeout: Duration.seconds(3),
        }),
      );
      const before = yield* Lambda.getFunction({ FunctionName: fn.functionName });
      const ownership = Object.keys(before.Tags ?? {}).filter((key) => key.startsWith("alchemy::"));
      expect(ownership.length).toBeGreaterThan(0);

      yield* Lambda.untagResource({ Resource: fn.functionArn, TagKeys: ownership });
      yield* Lambda.updateFunctionConfiguration({
        FunctionName: fn.functionName,
        MemorySize: 256,
      }).pipe(
        Effect.retry({
          while: (e) => e._tag === "ResourceConflictException",
          schedule: Schedule.exponential(500),
          times: 8,
        }),
      );
      yield* waitForConfiguration(fn.functionName, { memorySize: 256, timeout: 3 });

      const target = { name: stack.name, stage: stack.stage };
      const detected = yield* Drift.detect(target).pipe(Effect.provide(stack.state));
      expect(detected.resources.DriftTagsFn?.action).toBe("drifted");

      const repaired = yield* Drift.repair(target).pipe(Effect.provide(stack.state));
      expect(repaired.resources.DriftTagsFn?.action).toBe("repaired");
      yield* waitForConfiguration(fn.functionName, { memorySize: 128, timeout: 3 });
      const after = yield* Lambda.getFunction({ FunctionName: fn.functionName });
      for (const key of ownership) expect(after.Tags?.[key]).toBe(before.Tags?.[key]);

      yield* stack.destroy();
      yield* assertFunctionDeleted(fn.functionName);
    }).pipe(Effect.onError(() => stack.destroy().pipe(Effect.ignore))),
  { tags: ["provider:aws", "provider:aws:lambda", "live"], timeout: 240_000 },
);

// #2659: `read` must observe every setting reconcile converges — environment,
// tracing, code, URL auth/CORS, log retention, execution-role policies — or
// an out-of-band change reads as `unchanged` and drift never repairs it.
test.provider(
  "drift detects and repairs out-of-band configuration, code, URL and role changes",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const fn = yield* stack.deploy(
        AWS.Lambda.Function("DriftConfigFn", {
          main: timeoutHandlerPath,
          handler: "handler",
          isExternal: true,
          functionUrl: { authType: "NONE" },
          env: { DRIFT_MARKER: "declared" },
          logging: { retention: "1 week" },
        }),
      );
      const target = { name: stack.name, stage: stack.stage };
      const detect = Drift.detect(target).pipe(
        Effect.map((result) => result.resources.DriftConfigFn),
        Effect.provide(stack.state),
      );
      expect((yield* detect)?.action).toBe("unchanged");
      const deployed = yield* Lambda.getFunctionConfiguration({ FunctionName: fn.functionName });

      const settled = Lambda.getFunctionConfiguration({ FunctionName: fn.functionName }).pipe(
        Effect.repeat({
          until: (config) => config.LastUpdateStatus === "Successful",
          schedule: Schedule.spaced("1 second"),
          times: 30,
        }),
      );
      yield* Lambda.updateFunctionConfiguration({
        FunctionName: fn.functionName,
        Environment: {
          Variables: { ...deployed.Environment?.Variables, DRIFT_MARKER: "out-of-band" },
        },
        TracingConfig: { Mode: "Active" },
      }).pipe(
        Effect.retry({
          while: (e) => e._tag === "ResourceConflictException",
          schedule: Schedule.exponential(500),
          times: 8,
        }),
      );
      yield* settled;
      yield* Lambda.updateFunctionCode({
        FunctionName: fn.functionName,
        ZipFile: yield* zipCode("export const handler = async () => 'replaced';"),
      }).pipe(
        Effect.retry({
          while: (e) => e._tag === "ResourceConflictException",
          schedule: Schedule.exponential(500),
          times: 8,
        }),
      );
      yield* settled;
      yield* Lambda.updateFunctionUrlConfig({
        FunctionName: fn.functionName,
        AuthType: "AWS_IAM",
        Cors: { AllowOrigins: ["https://example.com"] },
      }).pipe(
        Effect.retry({
          while: (e) => e._tag === "ResourceConflictException",
          schedule: Schedule.exponential(500),
          times: 8,
        }),
      );
      yield* Logs.putRetentionPolicy({
        logGroupName: `/aws/lambda/${fn.functionName}`,
        retentionInDays: 30,
      });
      yield* iam.detachRolePolicy({
        RoleName: fn.roleName,
        PolicyArn: "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole",
      });

      const drifted = yield* detect.pipe(
        Effect.repeat({
          until: (result) =>
            result?.attr?.tracing === "Active" &&
            result.attr.codeSha256 !== deployed.CodeSha256 &&
            result.attr.functionUrlConfig?.authType === "AWS_IAM" &&
            result.attr.logRetentionInDays === 30 &&
            result.attr.executionRole?.managedPolicyArns.length === 0,
          schedule: Schedule.spaced("2 seconds"),
          times: 15,
        }),
      );
      expect(drifted?.action).toBe("drifted");
      expect(drifted?.attr?.environment?.DRIFT_MARKER).toBeDefined();
      expect(drifted?.attr?.functionUrlConfig?.cors?.AllowOrigins).toEqual(["https://example.com"]);

      const repaired = yield* Drift.repair(target).pipe(Effect.provide(stack.state));
      expect(repaired.resources.DriftConfigFn?.action).toBe("repaired");
      expect((yield* detect)?.action).toBe("unchanged");

      const config = yield* Lambda.getFunctionConfiguration({ FunctionName: fn.functionName });
      const marker = config.Environment?.Variables?.DRIFT_MARKER;
      expect(Redacted.isRedacted(marker) ? Redacted.value(marker) : marker).toBe("declared");
      expect(config.TracingConfig?.Mode).toBe("PassThrough");
      expect(config.CodeSha256).toBe(deployed.CodeSha256);
      const url = yield* Lambda.getFunctionUrlConfig({ FunctionName: fn.functionName });
      expect(url.AuthType).toBe("NONE");
      expect(url.Cors?.AllowOrigins ?? []).toEqual([]);
      const groups = yield* Logs.describeLogGroups({
        logGroupNamePrefix: `/aws/lambda/${fn.functionName}`,
      });
      expect(groups.logGroups?.[0]?.retentionInDays).toBe(7);
      const attached = yield* iam.listAttachedRolePolicies({ RoleName: fn.roleName });
      expect(attached.AttachedPolicies?.map((policy) => policy.PolicyArn)).toContain(
        "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole",
      );

      yield* stack.destroy();
      yield* assertFunctionDeleted(fn.functionName);
    }).pipe(Effect.onError(() => stack.destroy().pipe(Effect.ignore))),
  { tags: ["provider:aws", "provider:aws:lambda", "live"], timeout: 300_000 },
);

// #1536: drift recreates a deleted function without its bindings, then
// attaches them — the environment and IAM statements come back.
test.provider(
  "drift repair recreates a deleted function and restores its bindings",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const fn = yield* stack.deploy(
        Effect.gen(function* () {
          const fn = yield* AWS.Lambda.Function("DriftBoundFn", {
            main: timeoutHandlerPath,
            handler: "handler",
            isExternal: true,
            functionUrl: false,
          });
          yield* fn.bind("DriftBinding", {
            env: { DRIFT_MARKER: "bound" },
            policyStatements: [
              {
                Sid: "DriftBinding",
                Effect: "Allow",
                Action: ["sqs:GetQueueUrl"],
                Resource: ["*"],
              },
            ],
          });
          return fn;
        }),
      );

      yield* Lambda.deleteFunction({ FunctionName: fn.functionName });
      yield* assertFunctionDeleted(fn.functionName);

      const target = { name: stack.name, stage: stack.stage };
      const detected = yield* Drift.detect(target).pipe(Effect.provide(stack.state));
      expect(detected.resources.DriftBoundFn?.action).toBe("missing");

      const repaired = yield* Drift.repair(target).pipe(Effect.provide(stack.state));
      expect(repaired.resources.DriftBoundFn?.action).toBe("recreated");

      const config = yield* Lambda.getFunctionConfiguration({ FunctionName: fn.functionName });
      const marker = config.Environment?.Variables?.DRIFT_MARKER;
      expect(Redacted.isRedacted(marker) ? Redacted.value(marker) : marker).toBe("bound");
      const policies = yield* iam.listRolePolicies({ RoleName: fn.roleName });
      const documents = yield* Effect.all(
        policies.PolicyNames.map((PolicyName) =>
          iam.getRolePolicy({ RoleName: fn.roleName, PolicyName }),
        ),
      );
      expect(
        documents.some((doc) => decodeURIComponent(doc.PolicyDocument).includes("DriftBinding")),
      ).toBe(true);
      expect(
        (yield* Drift.detect(target).pipe(Effect.provide(stack.state))).resources.DriftBoundFn
          ?.action,
      ).toBe("unchanged");

      yield* stack.destroy();
      yield* assertFunctionDeleted(fn.functionName);
    }).pipe(Effect.onError(() => stack.destroy().pipe(Effect.ignore))),
  { tags: ["provider:aws", "provider:aws:lambda", "live"], timeout: 240_000 },
);

// Canonical `list()` test (AWS account/region-scoped collection): deploy a
// real function, resolve the provider from context via the typed
// `Provider.findProvider`, call `list()`, and assert the deployed function
// appears in the exhaustively-paginated result.
test.provider(
  "list enumerates the deployed function",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        AWS.Lambda.Function("ListFn", {
          main: timeoutHandlerPath,
          handler: "handler",
          isExternal: true,
          functionUrl: false,
        }),
      );

      const provider = yield* Provider.findProvider(AWS.Lambda.Function);
      const all = yield* provider.list();

      expect(all.some((f) => f.functionName === deployed.functionName)).toBe(true);

      yield* stack.destroy();
      yield* assertFunctionDeleted(deployed.functionName);
    }).pipe(
      Effect.tap(() => stack.destroy()),
      Effect.onError(() => stack.destroy().pipe(Effect.ignore)),
    ),
  { tags: ["provider:aws", "provider:aws:lambda", "live"], timeout: 180_000 },
);

test.provider(
  "streams an Effect HttpServerResponse through a RESPONSE_STREAM function URL",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { functionName, functionUrl } = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* StreamingFunction;
        }).pipe(Effect.provide(StreamingFunctionLive)),
      );
      expect(functionUrl).toBeTruthy();

      const response = yield* HttpClient.get(functionUrl!).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? Effect.succeed(response)
            : Effect.fail(new Error(`Function URL returned ${response.status}`)),
        ),
        Effect.retry({
          schedule: Schedule.max([Schedule.exponential(500), Schedule.recurs(10)]),
        }),
      );
      expect(response.headers["content-type"]).toBe("text/event-stream");
      expect(response.headers["x-streamed"]).toBe("true");
      expect(response.headers["set-cookie"]).toContain("session=abc");

      // Record when each event arrives: streamed events are ~2s apart, a
      // buffered body arrives in one piece at the end.
      const arrivals = yield* response.stream.pipe(
        Stream.decodeText(),
        Stream.mapEffect((text) =>
          Effect.map(
            Effect.clockWith((clock) => clock.currentTimeMillis),
            (at) => ({
              text,
              at,
            }),
          ),
        ),
        Stream.runCollect,
      );
      expect(arrivals.map((a) => a.text).join("")).toBe(
        "data: one\n\ndata: two\n\ndata: three\n\n",
      );
      expect(arrivals.length).toBeGreaterThanOrEqual(3);
      expect(arrivals[arrivals.length - 1]!.at - arrivals[0]!.at).toBeGreaterThanOrEqual(3_000);

      yield* stack.destroy();
      yield* assertFunctionDeleted(functionName);
    }).pipe(
      Effect.tap(() => stack.destroy()),
      Effect.onError(() => stack.destroy().pipe(Effect.ignore)),
    ),
  { tags: ["provider:aws", "provider:aws:lambda", "live"], timeout: 180_000 },
);

test.provider(
  "updates function URL auth to AWS_IAM",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const initial = yield* stack.deploy(
        AWS.Lambda.Function("IamUrlFn", {
          main: timeoutHandlerPath,
          handler: "handler",
          isExternal: true,
          functionUrl: true,
        }),
      );

      const invokePolicy = yield* getPolicyStatement(
        initial.functionName,
        "FunctionURLAllowPublicInvoke",
      );
      expect(invokePolicy.Condition).toEqual({
        Bool: {
          "lambda:InvokedViaFunctionUrl": "true",
        },
      });

      const updated = yield* stack.deploy(
        AWS.Lambda.Function("IamUrlFn", {
          main: timeoutHandlerPath,
          handler: "handler",
          isExternal: true,
          functionUrl: {
            authType: "AWS_IAM",
            cors: {
              AllowHeaders: ["authorization", "content-type"],
              AllowMethods: ["GET", "POST"],
              AllowOrigins: ["https://example.com"],
              ExposeHeaders: ["x-request-id"],
              MaxAge: 300,
            },
            invokeMode: "RESPONSE_STREAM",
          },
        }),
      );

      expect(updated.functionName).toBe(initial.functionName);
      expect(updated.functionUrl).toBeTruthy();

      const config = yield* getFunctionUrlConfigWithAuth(updated.functionName, "AWS_IAM");
      expect(config.AuthType).toBe("AWS_IAM");
      expect(config.InvokeMode).toBe("RESPONSE_STREAM");
      expect(config.Cors).toEqual({
        AllowHeaders: ["authorization", "content-type"],
        AllowMethods: ["GET", "POST"],
        AllowOrigins: ["https://example.com"],
        ExposeHeaders: ["x-request-id"],
        MaxAge: 300,
      });

      yield* waitForPolicyStatementAbsent(updated.functionName, "FunctionURLAllowPublicAccess");
      yield* waitForPolicyStatementAbsent(updated.functionName, "FunctionURLAllowPublicInvoke");

      const response = yield* HttpClient.get(updated.functionUrl!).pipe(
        Effect.flatMap((response) =>
          response.status === 403
            ? Effect.succeed(response)
            : Effect.fail(new Error(`IAM Function URL returned ${response.status}`)),
        ),
        Effect.retry({
          schedule: Schedule.max([Schedule.exponential(500), Schedule.recurs(10)]),
        }),
      );
      expect(response.status).toBe(403);

      yield* stack.destroy();
      yield* assertFunctionDeleted(initial.functionName);
    }).pipe(
      Effect.tap(() => stack.destroy()),
      Effect.onError(() => stack.destroy().pipe(Effect.ignore)),
    ),
  { tags: ["provider:aws", "provider:aws:lambda", "live"], timeout: 360_000 },
);

// `alias` publishes a version per deploy and routes every consumer through
// the alias: the function URL and the event-source mapping target `:live`,
// so moving the alias back to an earlier version rolls back without a
// redeploy. Removing `alias` moves them back to the unqualified function.
test.provider(
  "alias routes the function URL and event sources through the alias",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deploy = (alias: string | undefined, marker: string) =>
        stack.deploy(
          Effect.gen(function* () {
            const fn = yield* AliasFunction;
            yield* fn.bind`ReleaseMarker`({ env: { RELEASE_MARKER: marker } });
            return fn;
          }).pipe(Effect.provide(aliasFunction(alias))),
        );

      const v1 = yield* deploy("live", "v1");
      const aliasArn = `${v1.functionArn}:live`;
      expect(v1.aliasName).toBe("live");
      expect(v1.qualifiedArn).toBe(aliasArn);
      expect(v1.version).toMatch(/^[1-9]\d*$/);
      yield* assertAlias(v1.functionName, "live", v1.version!);
      yield* assertUrlQualifier(v1.functionName, v1.functionUrl!, "live");
      expect(yield* eventSourceMappingTargets(v1.functionName)).toEqual([aliasArn]);
      yield* expectServes(`${v1.functionName}:live`, "v1");

      // A new release advances the alias; consumers keep the same target.
      const v2 = yield* deploy("live", "v2");
      expect(v2.qualifiedArn).toBe(aliasArn);
      expect(v2.functionUrl).toBe(v1.functionUrl);
      expect(Number(v2.version)).toBeGreaterThan(Number(v1.version));
      yield* assertAlias(v2.functionName, "live", v2.version!);
      expect(yield* eventSourceMappingTargets(v2.functionName)).toEqual([aliasArn]);
      yield* expectServes(`${v2.functionName}:live`, "v2");

      // Rollback is one UpdateAlias call: everything wired to the alias
      // serves v1 again.
      yield* Lambda.updateAlias({
        FunctionName: v2.functionName,
        Name: "live",
        FunctionVersion: v1.version!,
      });
      yield* expectServes(`${v2.functionName}:live`, "v1");

      // Removing the alias moves the URL and mapping back to the function.
      const unaliased = yield* deploy(undefined, "v2");
      expect(unaliased.aliasName).toBeUndefined();
      expect(unaliased.qualifiedArn).toBe(unaliased.functionArn);
      yield* Lambda.getAlias({ FunctionName: unaliased.functionName, Name: "live" }).pipe(
        Effect.flatMap(() => Effect.fail(new Error("alias live still exists"))),
        Effect.catchTag("ResourceNotFoundException", () => Effect.void),
      );
      yield* assertUrlQualifier(unaliased.functionName, unaliased.functionUrl!, undefined);
      expect(yield* eventSourceMappingTargets(unaliased.functionName)).toEqual([
        unaliased.functionArn,
      ]);
      yield* expectServes(unaliased.functionName, "v2");

      yield* stack.destroy();
      yield* assertFunctionDeleted(unaliased.functionName);
    }).pipe(
      Effect.tap(() => stack.destroy()),
      Effect.onError(() => stack.destroy().pipe(Effect.ignore)),
    ),
  {
    tags: ["provider:aws", "provider:aws:lambda", "provider:aws:sqs", "live"],
    timeout: 360_000,
  },
);

// Alias moves are eventually consistent: poll until the qualifier serves the
// expected release.
const expectServes = Effect.fn(function* (functionName: string, marker: string) {
  const body = yield* invokeHttpFunction(functionName).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (body) => body === marker,
      times: 20,
    }),
  );
  expect(body).toBe(marker);
});

const assertAlias = Effect.fn(function* (functionName: string, alias: string, version: string) {
  const observed = yield* Lambda.getAlias({ FunctionName: functionName, Name: alias });
  expect(observed.FunctionVersion).toBe(version);
});

// The function URL lives on exactly one qualifier: the alias, or the
// unqualified function when there is none.
const assertUrlQualifier = Effect.fn(function* (
  functionName: string,
  functionUrl: string,
  qualifier: string | undefined,
) {
  const config = yield* Lambda.getFunctionUrlConfig({
    FunctionName: functionName,
    Qualifier: qualifier,
  });
  expect(config.FunctionUrl).toBe(functionUrl);
  expect(config.FunctionArn).toMatch(qualifier ? new RegExp(`:${qualifier}$`) : /:function:[^:]+$/);
  if (qualifier !== undefined) {
    const unqualified = yield* Lambda.getFunctionUrlConfig({ FunctionName: functionName }).pipe(
      Effect.map(() => "present" as const),
      Effect.catchTag("ResourceNotFoundException", () => Effect.succeed("absent" as const)),
    );
    expect(unqualified).toBe("absent");
  }
});

// Function ARNs every event-source mapping on the function (any qualifier)
// invokes.
const eventSourceMappingTargets = Effect.fn(function* (functionName: string) {
  const mappings = yield* Lambda.listEventSourceMappings.items({}).pipe(
    Stream.filter((mapping) =>
      (mapping.FunctionArn ?? "").split(":").slice(6, 7).includes(functionName),
    ),
    Stream.runCollect,
  );
  return Array.from(mappings).map((mapping) => mapping.FunctionArn);
});

const assertFunctionReady = Effect.fn(function* (functionName: string, marker: string) {
  // Deploy must finish configuration propagation; these checks never retry.
  const { Configuration } = yield* Lambda.getFunction({
    FunctionName: functionName,
  });
  expect(Configuration?.State).toBe("Active");
  expect(Configuration?.LastUpdateStatus).toBe("Successful");
  const observed = Configuration?.Environment?.Variables?.READINESS_MARKER;
  expect(Redacted.isRedacted(observed) ? Redacted.value(observed) : observed).toBe(marker);

  expect(yield* invokeHttpFunction(functionName, "/readiness")).toBe(marker);
});

const invokeHttpFunction = Effect.fn(function* (functionName: string, path = "/") {
  const response = yield* Lambda.invoke({
    FunctionName: functionName,
    Payload: JSON.stringify({
      version: "2.0",
      rawPath: path,
      rawQueryString: "",
      headers: { host: "localhost" },
      requestContext: {
        http: {
          method: "GET",
          path,
          protocol: "HTTP/1.1",
          sourceIp: "127.0.0.1",
          userAgent: "alchemy-test",
        },
      },
      isBase64Encoded: false,
    }),
  });
  expect(response.FunctionError).toBeUndefined();
  const payload = response.Payload
    ? yield* response.Payload.pipe(Stream.decodeText(), Stream.mkString)
    : "";
  const body = yield* Effect.try(() => JSON.parse(payload));
  expect(body.statusCode).toBe(200);
  return body.body as string;
});

// A cycle precreates on unresolved props, before `read` can check ownership.
// `observe` must refuse a foreign function at the precreate identity before
// precreate's create-or-update overwrites it. The queue URL keeps the props
// unresolved; the self-binding puts the function in a cycle.
const cyclicFunction = (functionName: string, scoped?: boolean) =>
  Effect.gen(function* () {
    const queue = yield* AWS.SQS.Queue("CyclicQueue");
    const declaration = AWS.Lambda.Function("CyclicDifferent", {
      main: asyncHandlerPath,
      functionName,
      functionUrl: false,
      env: { QUEUE_URL: queue.queueUrl },
    });
    const fn = yield* scoped === undefined ? declaration : declaration.pipe(adopt(scoped));
    yield* fn.bind`Self`({ env: { SELF_NAME: fn.functionName } });
    return fn;
  });

/**
 * Deploys `CyclicOriginal`, then forgets it, leaving a function owned by
 * another logical id. Returns a step that remembers it again, so destroy
 * removes it — and its execution role — through normal stack cleanup.
 */
const plantForeignFunction = Effect.fn(function* (stack: Test.ScratchStack) {
  yield* stack.destroy();
  const original = yield* stack.deploy(
    AWS.Lambda.Function("CyclicOriginal", { main: asyncHandlerPath, functionUrl: false }),
  );
  const key = { stack: stack.name, stage: stack.stage, fqn: "CyclicOriginal" };
  const row = yield* Effect.gen(function* () {
    const state = yield* yield* State;
    const value = yield* state.get(key);
    yield* state.delete(key);
    return value!;
  }).pipe(Effect.provide(stack.state));
  const restore = Effect.gen(function* () {
    const state = yield* yield* State;
    yield* state.set({ ...key, value: row });
  }).pipe(Effect.provide(stack.state));
  return { original, restore };
});

for (const scoped of [undefined, false]) {
  test.provider(
    `a cyclic precreate refuses a foreign function (scoped adoption ${scoped})`,
    (stack) =>
      Effect.gen(function* () {
        const { original, restore } = yield* plantForeignFunction(stack);
        const before = yield* Lambda.getFunction({ FunctionName: original.functionName });
        const program = cyclicFunction(original.functionName, scoped);
        expect((yield* stack.plan(program)).resources.CyclicDifferent?.action).toBe("create");
        const error = yield* stack.deploy(program).pipe(Effect.flip);
        expect(error).toMatchObject({ _tag: "OwnedBySomeoneElse", logicalId: "CyclicDifferent" });
        // Neither the function's code nor its configuration changed.
        const after = yield* Lambda.getFunction({ FunctionName: original.functionName });
        expect(after.Configuration?.CodeSha256).toBe(before.Configuration?.CodeSha256);
        expect(after.Configuration?.LastModified).toBe(before.Configuration?.LastModified);
        expect(after.Tags).toEqual(before.Tags);
        yield* stack.destroy();
        yield* restore;
        yield* stack.destroy();
        yield* assertFunctionDeleted(original.functionName);
        yield* assertRoleDeleted(original.roleName);
      }).pipe(Effect.onError(() => stack.destroy().pipe(Effect.ignore))),
    {
      tags: ["provider:aws", "provider:aws:iam", "provider:aws:lambda", "live"],
      timeout: 180_000,
    },
  );
}

// Outside a cycle `read` refuses the foreign function at plan time; with
// adoption, reconcile updates it from the adopted attributes. That update must
// not re-check the tags the engine already admitted, and re-brands it.
test.provider(
  "adopt(true) takes over a foreign function outside a cycle",
  (stack) =>
    Effect.gen(function* () {
      const { original, restore } = yield* plantForeignFunction(stack);
      const adopted = yield* stack.deploy(
        AWS.Lambda.Function("AdoptedFn", {
          main: asyncHandlerPath,
          functionName: original.functionName,
          functionUrl: false,
        }).pipe(adopt(true)),
      );
      expect(adopted.functionName).toBe(original.functionName);
      const { Tags } = yield* Lambda.getFunction({ FunctionName: original.functionName });
      expect(Tags?.["alchemy::id"]).toBe("AdoptedFn");
      yield* stack.destroy();
      yield* assertFunctionDeleted(original.functionName);
      yield* assertRoleDeleted(adopted.roleName);
      // The taken-over function's previous execution role is still `CyclicOriginal`'s.
      yield* restore;
      yield* stack.destroy();
      yield* assertRoleDeleted(original.roleName);
    }).pipe(Effect.onError(() => stack.destroy().pipe(Effect.ignore))),
  {
    tags: ["provider:aws", "provider:aws:iam", "provider:aws:lambda", "live"],
    timeout: 180_000,
  },
);

test.provider(
  "a cyclic precreate takes over a foreign function with adopt(true)",
  (stack) =>
    Effect.gen(function* () {
      const { original, restore } = yield* plantForeignFunction(stack);
      const adopted = yield* stack.deploy(cyclicFunction(original.functionName, true));
      expect(adopted.functionName).toBe(original.functionName);
      const { Tags } = yield* Lambda.getFunction({ FunctionName: original.functionName });
      expect(Tags?.["alchemy::id"]).toBe("CyclicDifferent");
      yield* stack.destroy();
      yield* assertFunctionDeleted(original.functionName);
      yield* assertRoleDeleted(adopted.roleName);
      // The taken-over function's previous execution role is still `CyclicOriginal`'s.
      yield* restore;
      yield* stack.destroy();
      yield* assertRoleDeleted(original.roleName);
    }).pipe(Effect.onError(() => stack.destroy().pipe(Effect.ignore))),
  {
    tags: ["provider:aws", "provider:aws:iam", "provider:aws:lambda", "live"],
    timeout: 180_000,
  },
);

// A cycle precreates before its peers reconcile, but a name from a resource
// outside the cycle resolves first, so precreate names the function with it.
test.provider(
  "a cyclic function precreates a name from a resource outside its cycle",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { fn, queueName } = yield* stack.deploy(
        Effect.gen(function* () {
          const queue = yield* AWS.SQS.Queue("NamingQueue");
          const fn = yield* AWS.Lambda.Function("CyclicNamed", {
            main: asyncHandlerPath,
            functionName: queue.queueName.pipe(Output.map((name) => `${name.slice(-56)}-named`)),
            functionUrl: false,
          });
          yield* fn.bind`Self`({ env: { SELF_NAME: fn.functionName } });
          return { fn, queueName: queue.queueName };
        }),
      );
      expect(fn.functionName).toBe(`${queueName.slice(-56)}-named`);
      const live = yield* Lambda.getFunction({ FunctionName: fn.functionName });
      const selfName = live.Configuration?.Environment?.Variables?.SELF_NAME;
      expect(Redacted.isRedacted(selfName) ? Redacted.value(selfName) : selfName).toBe(
        fn.functionName,
      );
      yield* stack.destroy();
      yield* assertFunctionDeleted(fn.functionName);
      yield* assertRoleDeleted(fn.roleName);
    }).pipe(Effect.onError(() => stack.destroy().pipe(Effect.ignore))),
  {
    tags: ["provider:aws", "provider:aws:iam", "provider:aws:lambda", "provider:aws:sqs", "live"],
    timeout: 180_000,
  },
);

// A name derived from a peer in the function's own cycle is still unresolved
// when the function precreates, so precreate refuses to guess one.
test.provider(
  "a cyclic function refuses a name derived from a peer in its cycle",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const error = yield* stack
        .deploy(
          Effect.gen(function* () {
            const peer = yield* AWS.Lambda.Function("NamingPeer", {
              main: asyncHandlerPath,
              functionUrl: false,
            });
            const fn = yield* AWS.Lambda.Function("PeerNamed", {
              main: asyncHandlerPath,
              functionName: peer.functionName.pipe(
                Output.map((name) => `${name.slice(-56)}-named`),
              ),
              functionUrl: false,
            });
            yield* peer.bind`Named`({ env: { NAMED: fn.functionName } });
            return fn;
          }),
        )
        .pipe(Effect.flip);
      expect(error).toMatchObject({ _tag: "UnresolvedIdentity", logicalId: "PeerNamed" });
      yield* stack.destroy();
    }).pipe(Effect.onError(() => stack.destroy().pipe(Effect.ignore))),
  {
    tags: ["provider:aws", "provider:aws:iam", "provider:aws:lambda", "live"],
    timeout: 180_000,
  },
);

// Out-of-band proof that the trailing destroy actually removed the function
// from the cloud (bounded retry to ride out delete propagation).
const assertFunctionDeleted = Effect.fn(function* (functionName: string) {
  yield* Lambda.getFunction({ FunctionName: functionName }).pipe(
    Effect.flatMap(() => Effect.fail(new Error(`Function ${functionName} still exists`))),
    Effect.catchTag("ResourceNotFoundException", () => Effect.void),
    Effect.retry({
      schedule: Schedule.max([Schedule.exponential(500), Schedule.recurs(8)]),
    }),
  );
});

// Function cleanup owns its generated execution role. Verify the role is not
// stranded when deletion also waits for Lambda's asynchronous log flush.
const assertRoleDeleted = Effect.fn(function* (roleName: string) {
  yield* iam.getRole({ RoleName: roleName }).pipe(
    Effect.flatMap(() => Effect.fail(new Error(`Role ${roleName} still exists`))),
    Effect.catchTag("NoSuchEntityException", () => Effect.void),
    Effect.retry({
      schedule: Schedule.spaced("1 second"),
      times: 8,
    }),
  );
});

const getPolicyStatement = Effect.fn(function* (functionName: string, statementId: string) {
  return yield* findPolicyStatement(functionName, statementId).pipe(
    Effect.flatMap((statement) =>
      statement
        ? Effect.succeed(statement)
        : Effect.fail(new Error(`Policy statement ${statementId} not found`)),
    ),
    Effect.retry({
      schedule: Schedule.max([Schedule.exponential(500), Schedule.recurs(10)]),
    }),
  );
});

const waitForPolicyStatementAbsent = Effect.fn(function* (
  functionName: string,
  statementId: string,
) {
  yield* findPolicyStatement(functionName, statementId).pipe(
    Effect.flatMap((statement) =>
      statement
        ? Effect.fail(new Error(`Policy statement ${statementId} still exists`))
        : Effect.void,
    ),
    Effect.retry({
      schedule: Schedule.max([Schedule.exponential(500), Schedule.recurs(10)]),
    }),
  );
});

const findPolicyStatement = Effect.fn(function* (functionName: string, statementId: string) {
  return yield* Lambda.getPolicy({ FunctionName: functionName }).pipe(
    Effect.flatMap(({ Policy }) =>
      Effect.try({
        try: () => {
          const policy = JSON.parse(Policy ?? "{}") as {
            Statement?: Array<{
              Sid?: string;
              Condition?: unknown;
            }>;
          };
          return policy.Statement?.find((statement) => statement.Sid === statementId);
        },
        catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
      }),
    ),
    Effect.catchTag("ResourceNotFoundException", () => Effect.succeed(undefined)),
  );
});

const getFunctionUrlConfigWithAuth = Effect.fn(function* (
  functionName: string,
  authType: Lambda.FunctionUrlAuthType,
) {
  return yield* Lambda.getFunctionUrlConfig({
    FunctionName: functionName,
  }).pipe(
    Effect.filterOrFail(
      (config) => config.AuthType === authType,
      () => new Error("Function URL auth has not propagated yet"),
    ),
    Effect.retry({
      schedule: Schedule.max([Schedule.exponential(500), Schedule.recurs(10)]),
    }),
  );
});

const waitForReservedConcurrency = Effect.fn(function* (
  functionName: string,
  expected: number | undefined,
) {
  return yield* Lambda.getFunctionConcurrency({
    FunctionName: functionName,
  }).pipe(
    Effect.map((config) => config.ReservedConcurrentExecutions),
    Effect.catchTag("ResourceNotFoundException", () => Effect.succeed(undefined)),
    Effect.filterOrFail(
      (actual) => actual === expected,
      () => new Error("Reserved concurrency update has not propagated yet"),
    ),
    Effect.retry({
      schedule: Schedule.max([Schedule.exponential(500), Schedule.recurs(10)]),
    }),
  );
});

const waitForConfiguration = Effect.fn(function* (
  functionName: string,
  expected: { memorySize: number; timeout: number },
) {
  return yield* Lambda.getFunctionConfiguration({ FunctionName: functionName }).pipe(
    Effect.filterOrFail(
      (config) =>
        config.MemorySize === expected.memorySize &&
        config.Timeout === expected.timeout &&
        config.LastUpdateStatus === "Successful",
      () => new Error("Lambda configuration update has not propagated yet"),
    ),
    Effect.retry({
      schedule: Schedule.max([Schedule.exponential(500), Schedule.recurs(10)]),
    }),
  );
});

const waitForArchitecture = Effect.fn(function* (
  functionName: string,
  expected: AWS.Lambda.FunctionArchitecture,
) {
  return yield* Lambda.getFunction({ FunctionName: functionName }).pipe(
    Effect.map((result) => result.Configuration?.Architectures),
    Effect.filterOrFail(
      (architectures) => architectures?.[0] === expected,
      () => new Error("Lambda architecture update has not propagated yet"),
    ),
    Effect.retry({
      schedule: Schedule.max([Schedule.exponential(500), Schedule.recurs(10)]),
    }),
  );
});
