import * as Alchemy from "@/index";
import { providers } from "@/Neon/Providers";
import * as Test from "@/Test/Alchemy";
import * as Api from "@distilled.cloud/neon";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/http/HttpClient";
import EventFunction from "./fixtures/function-events.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: providers(),
});
const Stack = Alchemy.Stack(
  "NeonFunctionEvents",
  { providers: providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const api = yield* EventFunction;
    return {
      url: api.url,
      projectId: api.projectId,
      branchId: api.branchId,
      slug: api.slug,
    };
  }),
);
const stack = beforeAll(destroy(Stack).pipe(Effect.andThen(deploy(Stack))));
afterAll(destroy(Stack));

test.provider(
  "event-source bindings register independent triggers without dependency cycles",
  () =>
    Effect.gen(function* () {
      const deployed = yield* stack;
      const { triggers } = yield* Api.listProjectBranchTriggers({
        project_id: deployed.projectId,
        branch_id: deployed.branchId,
      });
      expect(
        triggers
          .filter((trigger) => trigger.function_slug === deployed.slug)
          .map((trigger) => trigger.type)
          .sort(),
      ).toEqual(["schedule", "storage_object_created"]);
      expect(triggers.every((trigger) => trigger.enabled)).toBe(true);
    }),
  {
    tags: [
      "provider:neon",
      "provider:neon:bucket",
      "provider:neon:function",
      "provider:neon:project",
      "live",
    ],
    timeout: 120_000,
  },
);

test(
  "real bucket uploads invoke the typed prefix-filtered event route",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const client = yield* HttpClient.HttpClient;
    expect((yield* client.post(`${url}upload`)).status).toBe(204);
    // Bucket event delivery is eventually consistent; poll up to 2 minutes.
    const events = yield* client.get(url).pipe(
      Effect.flatMap((response) => response.json),
      Effect.repeat({
        schedule: Schedule.spaced("5 seconds"),
        until: (body) => JSON.stringify(body).includes("incoming/test.txt"),
      }),
      Effect.timeout("2 minutes"),
    );
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "upload",
          object_key: "incoming/test.txt",
        }),
      ]),
    );
    expect(JSON.stringify(events)).not.toContain("outside.txt");
  }),
  {
    tags: [
      "provider:neon",
      "provider:neon:bucket",
      "provider:neon:function",
      "provider:neon:project",
      "live",
    ],
    timeout: 180_000,
  },
);

test(
  "real minute schedule invokes the typed cron route",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const client = yield* HttpClient.HttpClient;
    const events = yield* client.get(url).pipe(
      Effect.flatMap((response) => response.json),
      Effect.repeat({
        schedule: Schedule.spaced("6 seconds"),
        times: 9,
        until: (body) => JSON.stringify(body).includes('"schedule"'),
      }),
    );
    expect(events).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "schedule" })]),
    );
  }),
  {
    tags: [
      "provider:neon",
      "provider:neon:bucket",
      "provider:neon:function",
      "provider:neon:project",
      "live",
    ],
    timeout: 120_000,
  },
);
