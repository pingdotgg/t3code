import * as AWS from "@/AWS";
import * as Core from "@/Test/Core";
import * as Test from "@/Test/Alchemy";
import * as mq from "@distilled.cloud/aws/mq";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import MQBindingsFunctionLive, { MQBindingsFunction } from "./bindings-handler";

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);

// A broker bills per instance-hour and takes 5-10 min to provision, so the
// live Lambda E2E is gated behind AWS_TEST_SLOW=1 (matching Broker.test.ts).
const RUN_LIVE = !!process.env.AWS_TEST_SLOW;

// A well-formed but nonexistent broker id (the same shape Broker.test.ts
// proves returns the typed NotFoundException for describeBroker).
const BOGUS_BROKER_ID = "b-00000000-0000-0000-0000-000000000000";

// Ungated typed-error probes: prove the distilled error unions the bindings
// depend on are typed, on every account, at near-zero cost.
test.provider(
  "listUsers on a nonexistent broker fails with NotFoundException",
  () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        mq.listUsers({ BrokerId: BOGUS_BROKER_ID }),
      );
      expect(error._tag).toBe("NotFoundException");
    }),
);

test.provider(
  "createUser on a nonexistent broker fails with NotFoundException",
  () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        mq.createUser({
          BrokerId: BOGUS_BROKER_ID,
          Username: "alchemyprobe",
          Password: "SuperSecretPassw0rd!",
        }),
      );
      expect(error._tag).toBe("NotFoundException");
    }),
);

test.provider(
  "rebootBroker on a nonexistent broker fails with NotFoundException",
  () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        mq.rebootBroker({ BrokerId: BOGUS_BROKER_ID }),
      );
      expect(error._tag).toBe("NotFoundException");
    }),
);

test.provider("promote on a nonexistent broker fails with a typed tag", () =>
  Effect.gen(function* () {
    const error = yield* Effect.flip(
      mq.promote({ BrokerId: BOGUS_BROKER_ID, Mode: "SWITCHOVER" }),
    );
    expect(["NotFoundException", "BadRequestException"]).toContain(error._tag);
  }),
);

const sharedStack = Core.scratchStack(testOptions, "MQBindings");

let baseUrl: string;

const get = (path: string) =>
  HttpClient.get(`${baseUrl}${path}`).pipe(Effect.flatMap((r) => r.json));
const post = (path: string) =>
  HttpClient.post(`${baseUrl}${path}`).pipe(Effect.flatMap((r) => r.json));

describe("MQ Bindings (E2E)", () => {
  beforeAll(
    Effect.gen(function* () {
      if (!RUN_LIVE) return;
      yield* Effect.logInfo("MQ E2E setup: destroying previous run");
      yield* sharedStack.destroy();

      yield* Effect.logInfo(
        "MQ E2E setup: deploying broker + Lambda (broker takes ~5-10 min)",
      );
      const { functionUrl } = yield* sharedStack.deploy(
        Effect.gen(function* () {
          return yield* MQBindingsFunction;
        }).pipe(Effect.provide(MQBindingsFunctionLive)),
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
    // broker create (~5-10 min) + Lambda deploy + readiness.
    { timeout: 1_200_000 },
  );
  afterAll(
    Effect.gen(function* () {
      if (!RUN_LIVE) return;
      // The Broker provider waits for the broker to settle (e.g. after the
      // /reboot test) and then for it to disappear.
      yield* sharedStack.destroy();
    }),
    { timeout: 1_200_000 },
  );

  test.provider.skipIf(!RUN_LIVE)(
    "all 9 capabilities initialize in the runtime",
    () =>
      Effect.gen(function* () {
        const response = (yield* get("/bindings")) as any;
        expect(response.bound).toHaveLength(9);
      }),
  );

  test.provider.skipIf(!RUN_LIVE)(
    "DescribeBroker reads the bound broker's state",
    () =>
      Effect.gen(function* () {
        const response = (yield* get("/broker")) as any;
        expect(typeof response.brokerName).toBe("string");
        expect(response.brokerState).toBe("RUNNING");
      }),
  );

  test.provider.skipIf(!RUN_LIVE)(
    "ListBrokers and ListUsers see the broker and its admin user",
    () =>
      Effect.gen(function* () {
        const brokers = (yield* get("/brokers")) as any;
        expect(brokers.count).toBeGreaterThanOrEqual(1);
        const users = (yield* get("/users")) as any;
        expect(users.count).toBeGreaterThanOrEqual(1);
      }),
  );

  test.provider.skipIf(!RUN_LIVE)(
    "CreateUser, DescribeUser, and DeleteUser round-trip a staged user",
    () =>
      Effect.gen(function* () {
        const response = (yield* post("/users")) as any;
        expect(response.created).toBe(true);
        expect(response.describedUsername).toBe("alchemytenant");
        expect(response.deleted).toBe(true);
      }),
  );

  test.provider.skipIf(!RUN_LIVE)(
    "UpdateUser surfaces the typed not-found for a nonexistent user",
    () =>
      Effect.gen(function* () {
        const response = (yield* post("/users/typed-not-found")) as any;
        expect(response.typed).toBe(true);
      }),
  );

  test.provider.skipIf(!RUN_LIVE)(
    "Promote on a non-CRDR broker surfaces the typed BadRequest",
    () =>
      Effect.gen(function* () {
        const response = (yield* post("/promote")) as any;
        expect(response.typed).toBe(true);
      }),
  );

  // LAST live test — kicks off a real reboot; afterAll's destroy waits for
  // the broker to settle before deleting it.
  test.provider.skipIf(!RUN_LIVE)("RebootBroker reboots the broker", () =>
    Effect.gen(function* () {
      const response = (yield* post("/reboot")) as any;
      expect(response.rebooting).toBe(true);
    }),
  );
});
