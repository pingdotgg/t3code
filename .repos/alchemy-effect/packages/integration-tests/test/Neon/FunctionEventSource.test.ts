import { providers } from "@alchemy.run/neon/Providers";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Api from "@distilled.cloud/neon";
import * as Alchemy from "alchemy";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Schedule from "effect/Schedule";
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

// Neon skipped the first occurrence after the trigger was created in a live
// probe and delivered the next one within ~4s, so wait through the occurrence
// after the reported next_run_at (up to ~2 minutes); skip under --fast.
test.provider.skipIf(!!process.env.FAST)(
  "real minute schedule invokes the typed cron route",
  () =>
    Effect.gen(function* () {
      const { url, projectId, branchId, slug } = yield* stack;
      const { triggers } = yield* Api.listProjectBranchTriggers({
        project_id: projectId,
        branch_id: branchId,
      });
      const minute = triggers.find(
        (trigger): trigger is Api.ScheduleTrigger =>
          trigger.type === "schedule" && trigger.function_slug === slug,
      );
      expect(minute?.next_run_at).toEqual(expect.any(String));
      const nextRunAt = Date.parse(minute!.next_run_at!);
      const now = yield* Clock.currentTimeMillis;
      const client = yield* HttpClient.HttpClient;
      const events = yield* client.get(url).pipe(
        Effect.flatMap((response) => response.json),
        Effect.repeat({
          schedule: Schedule.spaced("5 seconds"),
          until: (body) => JSON.stringify(body).includes('"schedule"'),
        }),
        Effect.timeout(Duration.millis(Math.max(nextRunAt - now, 0) + 75_000)),
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
    timeout: 180_000,
  },
);
