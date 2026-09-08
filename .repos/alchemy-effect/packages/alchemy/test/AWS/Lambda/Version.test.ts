import * as AWS from "@/AWS";
import * as Provider from "@/Provider";
import { destroy } from "@/RemovalPolicy";
import { isResourceState, State, type ResourceState } from "@/State";
import * as Test from "@/Test/Alchemy";
import * as Lambda from "@distilled.cloud/aws/lambda";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { fileURLToPath } from "node:url";

const handlerV1Path = fileURLToPath(
  new URL("./fixtures/version-handler-v1.ts", import.meta.url),
);
const handlerV2Path = fileURLToPath(
  new URL("./fixtures/version-handler-v2.ts", import.meta.url),
);

const { test } = Test.make({ providers: AWS.providers() });

test.provider(
  "publish, recover, promote, retain, list, and explicitly delete versions",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const program = ({
        handlerPath,
        envVersion,
        reservedConcurrentExecutions,
        includeVersion = true,
        includeAlias = true,
        destroyVersion = false,
      }: {
        handlerPath: string;
        envVersion: string;
        reservedConcurrentExecutions?: number;
        includeVersion?: boolean;
        includeAlias?: boolean;
        destroyVersion?: boolean;
      }) =>
        Effect.gen(function* () {
          const fn = yield* AWS.Lambda.Function("VersionedFn", {
            main: handlerPath,
            handler: "handler",
            isExternal: true,
            functionUrl: false,
            env: { VERSION: envVersion },
            reservedConcurrentExecutions,
          });

          const version = includeVersion
            ? yield* AWS.Lambda.Version("Release", {
                function: fn,
              }).pipe(destroy(destroyVersion))
            : undefined;

          const live =
            includeAlias && version
              ? yield* AWS.Lambda.Alias("Live", {
                  version,
                  aliasName: "live",
                })
              : undefined;

          return { fn, version, live };
        });

      // --- create ---
      const created = yield* stack.deploy(
        program({ handlerPath: handlerV1Path, envVersion: "one" }),
      );
      const v1 = created.version!;

      expect(v1.version).toMatch(/^[1-9]\d*$/);
      expect(v1.versionArn).toBe(`${v1.functionArn}:${v1.version}`);
      expect(v1.codeSha256).toBeTruthy();
      expect(v1.configSha256).toBeTruthy();
      expect(v1.sourceHash).toMatch(/^[a-f0-9]{64}$/);
      expect(created.live!.functionVersion).toBe(v1.version);

      const cloudV1 = yield* getVersionOrUndefined(v1.functionName, v1.version);
      expect(cloudV1?.FunctionArn).toBe(v1.versionArn);
      expect(cloudV1?.CodeSha256).toBe(v1.codeSha256);
      const countV1 = (yield* numberedVersions(v1.functionName)).length;

      // --- noop ---
      const unchanged = yield* stack.deploy(
        program({ handlerPath: handlerV1Path, envVersion: "one" }),
      );
      expect(unchanged.version!.version).toBe(v1.version);
      expect((yield* numberedVersions(v1.functionName)).length).toBe(countV1);

      // --- code change + alias promotion ---
      const codeChanged = yield* stack.deploy(
        program({ handlerPath: handlerV2Path, envVersion: "one" }),
      );
      const v2 = codeChanged.version!;
      expect(v2.version).not.toBe(v1.version);
      expect(v2.codeSha256).not.toBe(v1.codeSha256);
      expect(codeChanged.live!.aliasArn).toBe(created.live!.aliasArn);
      expect(codeChanged.live!.functionVersion).toBe(v2.version);
      expect((yield* numberedVersions(v1.functionName)).length).toBe(
        countV1 + 1,
      );
      expect(
        yield* getVersionOrUndefined(v1.functionName, v1.version),
      ).toBeDefined();

      // --- versioned configuration change ---
      const configChanged = yield* stack.deploy(
        program({ handlerPath: handlerV2Path, envVersion: "two" }),
      );
      const current = configChanged.version!;
      expect(current.version).not.toBe(v2.version);
      expect(current.codeSha256).toBe(v2.codeSha256);
      expect(current.configSha256).not.toBe(v2.configSha256);
      const countCurrent = (yield* numberedVersions(v1.functionName)).length;
      expect(countCurrent).toBe(countV1 + 2);

      // --- operational-only change ---
      const operational = yield* stack.deploy(
        program({
          handlerPath: handlerV2Path,
          envVersion: "two",
          reservedConcurrentExecutions: 0,
        }),
      );
      expect(operational.version!.version).toBe(current.version);
      expect((yield* numberedVersions(v1.functionName)).length).toBe(
        countCurrent,
      );

      // --- crash after PublishVersion, before state write ---
      // State resolves to an Effect that initializes and yields the concrete
      // state-store service.
      const state = yield* yield* State;
      const stage = "test";
      const fqns = yield* state.list({ stack: stack.name, stage });
      const rows = yield* Effect.forEach(fqns, (fqn) =>
        state
          .get({ stack: stack.name, stage, fqn })
          .pipe(Effect.map((row) => ({ fqn, row }))),
      );
      const versionRow = rows.find(
        (row): row is { fqn: string; row: ResourceState } =>
          isResourceState(row.row) &&
          row.row.resourceType === "AWS.Lambda.Version",
      );
      if (!versionRow?.row.props) {
        return yield* Effect.die(
          new Error("no persisted AWS.Lambda.Version props found after deploy"),
        );
      }
      yield* state.set({
        stack: stack.name,
        stage,
        fqn: versionRow.fqn,
        value: {
          ...versionRow.row,
          props: versionRow.row.props,
          status: "creating",
          attr: undefined,
        },
      });

      const recovered = yield* stack.deploy(
        program({
          handlerPath: handlerV2Path,
          envVersion: "two",
          reservedConcurrentExecutions: 0,
        }),
      );
      expect(recovered.version!.version).toBe(current.version);
      expect((yield* numberedVersions(v1.functionName)).length).toBe(
        countCurrent,
      );

      // --- retain on removal and recover on re-add ---
      yield* stack.deploy(
        program({
          handlerPath: handlerV2Path,
          envVersion: "two",
          reservedConcurrentExecutions: 0,
          includeVersion: false,
          includeAlias: false,
        }),
      );
      expect(
        yield* getVersionOrUndefined(v1.functionName, current.version),
      ).toBeDefined();

      const readded = yield* stack.deploy(
        program({
          handlerPath: handlerV2Path,
          envVersion: "two",
          reservedConcurrentExecutions: 0,
        }),
      );
      expect(readded.version!.version).toBe(current.version);
      expect((yield* numberedVersions(v1.functionName)).length).toBe(
        countCurrent,
      );

      // --- list + nuke posture ---
      const provider = yield* Provider.findProvider(AWS.Lambda.Version);
      expect(provider.nuke?.skip).toBe(true);
      const listed = yield* provider.list();
      expect(
        listed.some((version) => version.versionArn === current.versionArn),
      ).toBe(true);
      expect(listed.every((version) => version.version !== "$LATEST")).toBe(
        true,
      );

      // --- explicitly authorized, qualified-only deletion ---
      yield* stack.deploy(
        program({
          handlerPath: handlerV2Path,
          envVersion: "two",
          // Force an operational-only Version update so the explicit removal
          // policy is persisted before the resource is removed.
          reservedConcurrentExecutions: 1,
          destroyVersion: true,
        }),
      );
      yield* stack.deploy(
        program({
          handlerPath: handlerV2Path,
          envVersion: "two",
          reservedConcurrentExecutions: 1,
          includeVersion: false,
          includeAlias: false,
        }),
      );

      expect(
        yield* getVersionOrUndefined(v1.functionName, current.version),
      ).toBeUndefined();
      expect(
        yield* Lambda.getFunctionConfiguration({
          FunctionName: v1.functionName,
          Qualifier: "$LATEST",
        }),
      ).toBeDefined();
      expect(
        yield* getVersionOrUndefined(v1.functionName, v1.version),
      ).toBeDefined();

      yield* stack.destroy();
    }).pipe(
      Effect.tap(() => stack.destroy()),
      Effect.onError(() => stack.destroy().pipe(Effect.ignore)),
    ),
  { timeout: 360_000 },
);

const numberedVersions = Effect.fn(function* (functionName: string) {
  const response = yield* Lambda.listVersionsByFunction({
    FunctionName: functionName,
  });
  return (response.Versions ?? []).filter(
    (version) => version.Version !== "$LATEST",
  );
});

const getVersionOrUndefined = Effect.fn(function* (
  functionName: string,
  version: string,
) {
  return yield* Lambda.getFunctionConfiguration({
    FunctionName: functionName,
    Qualifier: version,
  }).pipe(
    Effect.catchTag("ResourceNotFoundException", () =>
      Effect.succeed(undefined),
    ),
  );
});
