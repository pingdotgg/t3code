import * as AWS from "@/AWS";
import * as Core from "@/Test/Core";
import * as Test from "@/Test/Alchemy";
import * as omics from "@distilled.cloud/aws/omics";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import OmicsBindingsFunctionLive, {
  OmicsBindingsFunction,
} from "./bindings-handler";

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);

// The live Lambda E2E provisions a SequenceStore + ReferenceStore + Lambda and
// exercises the runtime bindings end-to-end. It is gated behind AWS_TEST_OMICS
// (consistent with the async-provisioning lifecycles in Omics.test.ts). The
// ungated typed-error probes below prove the distilled error unions each
// binding depends on on every CI pass, entitled or not, at near-zero cost.
const RUN_LIVE = !!process.env.AWS_TEST_OMICS;

// Ungated typed-error probes — import the distilled ops directly, so this
// green path never loads the alchemy Omics binding module.
test.provider(
  "listReadSets on a nonexistent sequence store fails with a typed tag",
  () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        omics.listReadSets({ sequenceStoreId: "0000000000" }),
      );
      expect(["ResourceNotFoundException", "ValidationException"]).toContain(
        error._tag,
      );
    }),
);

test.provider("getRun on a nonexistent id fails with a typed tag", () =>
  Effect.gen(function* () {
    const error = yield* Effect.flip(omics.getRun({ id: "0000000000" }));
    expect(["ResourceNotFoundException", "ValidationException"]).toContain(
      error._tag,
    );
  }),
);

test.provider(
  "listReferences on a nonexistent reference store fails with a typed tag",
  () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        omics.listReferences({ referenceStoreId: "0000000000" }),
      );
      expect(["ResourceNotFoundException", "ValidationException"]).toContain(
        error._tag,
      );
    }),
);

const sharedStack = Core.scratchStack(testOptions, "OmicsBindings");

let baseUrl: string;

const get = (path: string) =>
  HttpClient.get(`${baseUrl}${path}`).pipe(Effect.flatMap((r) => r.json));

describe("Omics Bindings (E2E)", () => {
  beforeAll(
    Effect.gen(function* () {
      if (!RUN_LIVE) return;
      yield* Effect.logInfo("Omics E2E setup: destroying previous run");
      yield* sharedStack.destroy();

      yield* Effect.logInfo("Omics E2E setup: deploying stores + Lambda");
      const { functionUrl } = yield* sharedStack.deploy(
        Effect.gen(function* () {
          return yield* OmicsBindingsFunction;
        }).pipe(Effect.provide(OmicsBindingsFunctionLive)),
      );

      expect(functionUrl).toBeTruthy();
      baseUrl = functionUrl!.replace(/\/+$/, "");

      // Readiness probe — fresh function URLs take seconds to serve 200s.
      yield* HttpClient.get(`${baseUrl}/bindings`).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? Effect.succeed(response)
            : Effect.fail(new Error(`Function not ready: ${response.status}`)),
        ),
        Effect.retry({
          schedule: Schedule.max([
            Schedule.fixed("2 seconds"),
            Schedule.recurs(60),
          ]),
        }),
      );
    }),
    { timeout: 300_000 },
  );
  afterAll(
    Effect.gen(function* () {
      if (!RUN_LIVE) return;
      yield* sharedStack.destroy();
    }),
    { timeout: 300_000 },
  );

  test.provider.skipIf(!RUN_LIVE)(
    "all 8 capabilities initialize in the runtime",
    () =>
      Effect.gen(function* () {
        const response = (yield* get("/bindings")) as { bound: string[] };
        expect(response.bound).toHaveLength(8);
      }),
  );

  test.provider.skipIf(!RUN_LIVE)(
    "ListReadSets + ListReferences round-trip against the empty stores",
    () =>
      Effect.gen(function* () {
        const readSets = (yield* get("/readsets")) as { count: number };
        expect(readSets.count).toBe(0);
        const references = (yield* get("/references")) as { count: number };
        expect(references.count).toBe(0);
      }),
  );

  test.provider.skipIf(!RUN_LIVE)(
    "ListRuns round-trips at the account level",
    () =>
      Effect.gen(function* () {
        const runs = (yield* get("/runs")) as { count: number };
        expect(runs.count).toBeGreaterThanOrEqual(0);
      }),
  );

  test.provider.skipIf(!RUN_LIVE)(
    "GetReadSetMetadata + GetRun surface the typed not-found",
    () =>
      Effect.gen(function* () {
        const readset = (yield* get("/readset/typed-not-found")) as {
          typed: boolean;
        };
        expect(readset.typed).toBe(true);
        const run = (yield* get("/run/typed-not-found")) as { typed: boolean };
        expect(run.typed).toBe(true);
      }),
  );
});
