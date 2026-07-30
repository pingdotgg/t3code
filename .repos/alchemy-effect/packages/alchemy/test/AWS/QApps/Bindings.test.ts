import * as AWS from "@/AWS";
import * as Core from "@/Test/Core";
import * as Test from "@/Test/Alchemy";
import * as qapps from "@distilled.cloud/aws/qapps";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import QAppsTestFunctionLive, {
  QAppsTestFunction,
} from "./bindings-handler.ts";

const testOptions = { providers: AWS.providers() };
const { test } = Test.make(testOptions);

// A well-formed-but-nonexistent Q Business application environment instance
// the ungated probes are driven against.
const NONEXISTENT_INSTANCE = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const NONEXISTENT_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

// Without a Q Business instance, Amazon Q Apps rejects at the door with a
// typed UnauthorizedException ("Unauthorized") — the caller is not an IAM
// Identity Center user of any instance. An entitled account with bogus ids
// surfaces ResourceNotFoundException / AccessDeniedException /
// ValidationException instead; all are typed tags in the distilled unions.
const TYPED_REJECTIONS = [
  "UnauthorizedException",
  "ResourceNotFoundException",
  "AccessDeniedException",
  "ValidationException",
];

// ---------------------------------------------------------------------------
// Ungated typed-error probes: representative operations behind each binding
// group are exercised directly through distilled against a nonexistent
// instance and must answer with a typed tag. These prove the distilled error
// unions and request serialization (instance-id header, query/body shapes)
// at near-zero cost on every CI pass; the full runtime fixture below is
// gated behind an entitled Q Business instance.
// ---------------------------------------------------------------------------

describe("QApps data-plane operations (typed-error probes)", () => {
  const probes: Record<
    string,
    Effect.Effect<unknown, { _tag: string }, any>
  > = {
    startQAppSession: qapps.startQAppSession({
      instanceId: NONEXISTENT_INSTANCE,
      appId: NONEXISTENT_ID,
      appVersion: 1,
    }),
    getQAppSession: qapps.getQAppSession({
      instanceId: NONEXISTENT_INSTANCE,
      sessionId: NONEXISTENT_ID,
    }),
    listQApps: qapps.listQApps({ instanceId: NONEXISTENT_INSTANCE }),
    listCategories: qapps.listCategories({
      instanceId: NONEXISTENT_INSTANCE,
    }),
    batchCreateCategory: qapps.batchCreateCategory({
      instanceId: NONEXISTENT_INSTANCE,
      categories: [{ title: "alchemy-probe" }],
    }),
    createLibraryItem: qapps.createLibraryItem({
      instanceId: NONEXISTENT_INSTANCE,
      appId: NONEXISTENT_ID,
      appVersion: 1,
      categories: [],
    }),
    describeQAppPermissions: qapps.describeQAppPermissions({
      instanceId: NONEXISTENT_INSTANCE,
      appId: NONEXISTENT_ID,
    }),
    predictQApp: qapps.predictQApp({ instanceId: NONEXISTENT_INSTANCE }),
  };

  for (const [name, probe] of Object.entries(probes)) {
    test.provider(
      `${name} against a nonexistent instance yields a typed error`,
      () =>
        Effect.gen(function* () {
          const error = yield* Effect.flip(probe);
          expect(TYPED_REJECTIONS).toContain(error._tag);
        }),
      { timeout: 60_000 },
    );
  }
});

// ---------------------------------------------------------------------------
// Full runtime fixture: a Q App + a Lambda bound to six Q Apps bindings
// (sessions, permissions, inventory, categories — covering both the
// app/session-scoped and the instance-level builders). Amazon Q Apps lives
// inside a Q Business application environment instance (IAM Identity
// Center required), which the shared testing account does not have, so this
// is gated behind AWS_TEST_QAPPS=1 + QAPPS_INSTANCE_ID and always destroys
// what it created. Note: the Q Apps data plane authorizes the calling
// identity as an Identity Center user of the instance — an entitled runner
// must grant the Lambda's role access to the instance.
// ---------------------------------------------------------------------------

const sharedStack = Core.scratchStack(testOptions, "QAppsBindings");

test.provider.skipIf(!process.env.AWS_TEST_QAPPS)(
  "session, inventory, category, and permission bindings against a live instance",
  () =>
    Effect.gen(function* () {
      yield* sharedStack.destroy();

      yield* Effect.gen(function* () {
        const { functionUrl } = yield* sharedStack.deploy(
          Effect.gen(function* () {
            return yield* QAppsTestFunction;
          }).pipe(Effect.provide(QAppsTestFunctionLive)),
        );
        expect(functionUrl).toBeTruthy();
        const baseUrl = functionUrl!.replace(/\/+$/, "");

        const getJson = (path: string) =>
          HttpClient.get(`${baseUrl}${path}`).pipe(
            Effect.flatMap((response) =>
              response.status >= 500
                ? Effect.fail(
                    new Error(`transient upstream ${response.status}`),
                  )
                : Effect.succeed(response),
            ),
            Effect.retry({
              schedule: Schedule.max([
                Schedule.exponential("500 millis"),
                Schedule.recurs(10),
              ]),
            }),
            Effect.flatMap((r) => r.json),
          );

        // All six capabilities initialized in the runtime.
        const bindings = (yield* getJson("/bindings")) as { bound: string[] };
        expect(bindings.bound).toHaveLength(6);

        // ListQApps — instance-level builder, instance-id header injection.
        const apps = (yield* getJson("/apps")) as {
          count?: number;
          errorTag?: string;
        };
        expect(apps.errorTag).toBeUndefined();
        expect(apps.count).toBeGreaterThanOrEqual(1);

        // ListCategories — instance-level builder.
        const categories = (yield* getJson("/categories")) as {
          count?: number;
          errorTag?: string;
        };
        expect(categories.errorTag).toBeUndefined();

        // DescribeQAppPermissions — app-scoped builder, app-id injection.
        const permissions = (yield* getJson("/permissions")) as {
          resourceArn?: string;
          errorTag?: string;
        };
        expect(permissions.errorTag).toBeUndefined();

        // Session flow — start → get → stop against the deployed app.
        const session = (yield* getJson("/session")) as {
          sessionId?: string;
          status?: string;
          errorTag?: string;
        };
        expect(session.errorTag).toBeUndefined();
        expect(session.sessionId).toBeTruthy();
      }).pipe(Effect.ensuring(sharedStack.destroy().pipe(Effect.orDie)));
    }),
  { timeout: 600_000 },
);
