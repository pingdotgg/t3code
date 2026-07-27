import * as AWS from "@/AWS";
import * as Core from "@/Test/Core";
import * as Test from "@/Test/Alchemy";
import * as repostspace from "@distilled.cloud/aws/repostspace";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import RePostSpaceBindingsFunctionLive, {
  RePostSpaceBindingsFunction,
} from "./bindings-handler";

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);

// re:Post Private is a paid tier (Basic/Standard) that requires IAM Identity
// Center and provisions a space asynchronously (~30 minutes), so the live
// Lambda E2E is gated behind AWS_TEST_REPOSTSPACE=1. The ungated probes
// below prove the typed error unions the bindings depend on on every
// account at near-zero cost.
const RUN_LIVE = !!process.env.AWS_TEST_REPOSTSPACE;

const BOGUS_SPACE_ID = "SPalchemynonexistentprobe0";

test.provider(
  "getChannel on a nonexistent space fails with ResourceNotFoundException",
  () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        repostspace.getChannel({
          spaceId: BOGUS_SPACE_ID,
          channelId: "CHalchemynonexistentprobe0",
        }),
      );
      expect(error._tag).toBe("ResourceNotFoundException");
    }),
);

test.provider(
  "listChannels on a nonexistent space fails with ResourceNotFoundException",
  () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        repostspace.listChannels({ spaceId: BOGUS_SPACE_ID }),
      );
      expect(error._tag).toBe("ResourceNotFoundException");
    }),
);

test.provider("sendInvites on a nonexistent space fails with a typed tag", () =>
  Effect.gen(function* () {
    const error = yield* Effect.flip(
      repostspace.sendInvites({
        spaceId: BOGUS_SPACE_ID,
        accessorIds: ["00000000-0000-0000-0000-000000000000"],
        title: "alchemy probe",
        body: "alchemy probe",
      }),
    );
    expect(["ResourceNotFoundException", "ValidationException"]).toContain(
      error._tag,
    );
  }),
);

test.provider(
  "batchAddRole on a nonexistent space fails with a typed tag",
  () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        repostspace.batchAddRole({
          spaceId: BOGUS_SPACE_ID,
          accessorIds: ["00000000-0000-0000-0000-000000000000"],
          role: "EXPERT",
        }),
      );
      expect(["ResourceNotFoundException", "ValidationException"]).toContain(
        error._tag,
      );
    }),
);

const sharedStack = Core.scratchStack(testOptions, "RePostSpaceBindings");

let baseUrl: string;

const get = (path: string) =>
  HttpClient.get(`${baseUrl}${path}`).pipe(Effect.flatMap((r) => r.json));
const post = (path: string) =>
  HttpClient.post(`${baseUrl}${path}`).pipe(Effect.flatMap((r) => r.json));

describe("RePostSpace Bindings (E2E)", () => {
  beforeAll(
    Effect.gen(function* () {
      if (!RUN_LIVE) return;
      yield* Effect.logInfo("RePostSpace E2E setup: destroying previous run");
      yield* sharedStack.destroy();

      yield* Effect.logInfo(
        "RePostSpace E2E setup: deploying space + Lambda (~30 min)",
      );
      const { functionUrl } = yield* sharedStack.deploy(
        Effect.gen(function* () {
          return yield* RePostSpaceBindingsFunction;
        }).pipe(Effect.provide(RePostSpaceBindingsFunctionLive)),
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
    // space provisioning is asynchronous and can take ~30 minutes.
    { timeout: 3_600_000 },
  );
  afterAll(
    Effect.gen(function* () {
      if (!RUN_LIVE) return;
      // spaces bill while they exist — always destroy.
      yield* sharedStack.destroy();
    }),
    { timeout: 600_000 },
  );

  test.provider.skipIf(!RUN_LIVE)(
    "all 11 capabilities initialize in the runtime",
    () =>
      Effect.gen(function* () {
        const response = (yield* get("/bindings")) as any;
        expect(response.bound).toHaveLength(11);
      }),
  );

  test.provider.skipIf(!RUN_LIVE)(
    "CreateChannel + GetChannel + UpdateChannel + ListChannels round-trip",
    () =>
      Effect.gen(function* () {
        const created = (yield* post("/channels")) as any;
        expect(typeof created.channelId).toBe("string");
        expect(created.name).toBe("alchemy-bindings-channel");
        expect(created.renamed).toBe("alchemy-bindings-channel-renamed");

        const listed = (yield* get("/channels")) as any;
        expect(listed.count).toBeGreaterThanOrEqual(1);

        // Channel-role mutations against the real channel with a bogus
        // accessor — the API reports per-accessor errors (or a typed 400),
        // either proves the grant + injection end-to-end.
        const roles = (yield* post(
          `/channel-roles/bogus?channelId=${created.channelId}`,
        )) as any;
        expect(roles.added).toBeDefined();
        expect(roles.removed).toBeDefined();
      }),
    { timeout: 120_000 },
  );

  test.provider.skipIf(!RUN_LIVE)(
    "space-role and admin bindings surface typed results for bogus accessors",
    () =>
      Effect.gen(function* () {
        const roles = (yield* post("/roles/bogus")) as any;
        expect(roles.added).toBeDefined();
        expect(roles.removed).toBeDefined();

        const admins = (yield* post("/admins/bogus")) as any;
        expect(admins.register).toBeDefined();
        expect(admins.deregister).toBeDefined();

        const invites = (yield* post("/invites/bogus")) as any;
        expect(invites).toBeDefined();
      }),
    { timeout: 120_000 },
  );
});
