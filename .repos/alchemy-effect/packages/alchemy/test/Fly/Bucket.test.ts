import * as addons from "@distilled.cloud/fly-io/addons";
import * as machines from "@distilled.cloud/fly-io/machines";
import * as Fly from "@/Fly";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import BucketApi, {
  BucketIp,
  BucketSite,
  Data,
  OBJECT_BODY,
} from "./fixtures/bucket-api.ts";

const { test } = Test.make({ providers: Fly.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const listTigris = () =>
  Effect.gen(function* () {
    const rows: Array<{ id: string; name: string | null; options: unknown }> =
      [];
    let after: string | undefined;
    for (let i = 0; i < 8; i++) {
      const page = yield* addons.addOns({
        type: "tigris",
        first: 50,
        after,
      });
      for (const edge of page.edges ?? []) {
        if (edge?.node != null) rows.push(edge.node);
      }
      if (!page.pageInfo.hasNextPage) break;
      after = page.pageInfo.endCursor ?? undefined;
      if (after === undefined || after.length === 0) break;
    }
    return rows;
  });

const findAddOn = (addOnId: string, name: string) =>
  listTigris().pipe(
    Effect.map(
      (addOns) =>
        addOns.find((addOn) => addOn.id === addOnId) ??
        addOns.find((addOn) => addOn.name === name),
    ),
  );

const waitUntilBucketGone = (addOnId: string, name: string) =>
  findAddOn(addOnId, name).pipe(
    Effect.map((addOn) =>
      addOn === undefined ? ("gone" as const) : ("found" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

const waitUntilAppGone = (appName: string) =>
  machines.getApp({ app_name: appName }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

const listedSecrets = (appName: string) =>
  machines
    .listSecrets({
      app_name: appName,
      show_secrets: false,
    })
    .pipe(
      Effect.map(
        (res) => new Set((res.secrets ?? []).map((secret) => secret.name)),
      ),
      Effect.catchTag("NotFound", () => Effect.succeed(new Set<string>())),
    );

test.provider(
  "create, update, and destroy a tigris bucket",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Fly.Bucket("Data");
        }),
      );

      expect(created.addOnId).toEqual(expect.any(String));
      expect(created.addOnId.length).toBeGreaterThan(0);
      expect(created.name).toEqual(expect.any(String));
      expect(created.name.length).toBeGreaterThan(0);
      expect(created.public).toEqual(false);

      const fetched = yield* findAddOn(created.addOnId, created.name);
      expect(fetched).toBeDefined();
      expect(fetched?.id).toEqual(created.addOnId);
      expect(fetched?.name).toEqual(created.name);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Fly.Bucket("Data", {
            public: true,
          });
        }),
      );

      expect(updated.addOnId).toEqual(created.addOnId);
      expect(updated.name).toEqual(created.name);

      const refetched = yield* findAddOn(updated.addOnId, updated.name);
      expect(refetched).toBeDefined();
      expect(refetched?.id).toEqual(created.addOnId);

      const provider = yield* Provider.findProvider(Fly.Bucket);
      const all = yield* provider.list();
      const listed = all.find((row) => row.addOnId === created.addOnId);
      expect(listed).toBeDefined();
      expect(listed?.name).toEqual(created.name);

      yield* stack.destroy();

      const gone = yield* waitUntilBucketGone(created.addOnId, created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 120_000 },
);

test.provider(
  "replace when the name changes",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Fly.Bucket("Data");
        }),
      );

      const nextName = sanitizeReplaceName(created.name);
      const replaced = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Fly.Bucket("Data", {
            name: nextName,
          });
        }),
      );

      expect(replaced.name).toEqual(nextName);
      expect(replaced.addOnId).not.toEqual(created.addOnId);

      const oldGone = yield* findAddOn(created.addOnId, created.name);
      expect(oldGone).toBeUndefined();
      const next = yield* findAddOn(replaced.addOnId, replaced.name);
      expect(next).toBeDefined();
      expect(next?.name).toEqual(nextName);

      yield* stack.destroy();

      const gone = yield* waitUntilBucketGone(replaced.addOnId, replaced.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 120_000 },
);

test.provider(
  "a Service puts and gets an object on Tigris",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // Create the bucket first so Tigris credentials are persisted on
      // attributes. Same-plan Service reconcile otherwise runs before
      // Data is ready and GraphQL list omits `environment`.
      yield* stack.deploy(
        Effect.gen(function* () {
          const app = yield* BucketSite;
          const bucket = yield* Data;
          const ip = yield* BucketIp;
          return { app, bucket, ip };
        }),
      );

      const out = yield* stack.deploy(
        Effect.gen(function* () {
          const app = yield* BucketSite;
          const bucket = yield* Data;
          const ip = yield* BucketIp;
          const api = yield* BucketApi;
          return { app, bucket, ip, api };
        }),
      );

      expect(out.api.url).toEqual(`https://${out.app.appName}.fly.dev`);

      const names = yield* listedSecrets(out.app.appName).pipe(
        Effect.flatMap((set) =>
          set.has("BUCKET_NAME") && set.has("AWS_ACCESS_KEY_ID")
            ? Effect.succeed(set)
            : Effect.fail(
                new Error(
                  `missing Tigris secrets: ${[...set].join(",") || "(none)"}`,
                ),
              ),
        ),
        Effect.retry({
          schedule: Schedule.spaced("2 seconds"),
          times: 8,
        }),
      );
      expect(names.has("BUCKET_NAME")).toEqual(true);
      expect(names.has("AWS_ACCESS_KEY_ID")).toEqual(true);

      const untilOk = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        effect.pipe(
          Effect.retry({
            schedule: Schedule.spaced("4 seconds"),
            times: 10,
          }),
        );

      const put = yield* untilOk(
        HttpClient.get(`${out.api.url}/put`).pipe(
          Effect.flatMap((res) =>
            res.status === 200
              ? res.json
              : Effect.fail(new Error(`api returned ${res.status}`)),
          ),
          Effect.map((value) => value as { ok: boolean }),
        ),
      );
      expect(put.ok).toEqual(true);

      const got = yield* untilOk(
        HttpClient.get(`${out.api.url}/get`).pipe(
          Effect.flatMap((res) =>
            res.status === 200
              ? res.json
              : Effect.fail(new Error(`api returned ${res.status}`)),
          ),
          Effect.map((value) => value as { ok: boolean; text: string }),
        ),
      );
      expect(got.ok).toEqual(true);
      expect(got.text).toEqual(OBJECT_BODY);

      yield* stack.destroy();

      const bucketGone = yield* waitUntilBucketGone(
        out.bucket.addOnId,
        out.bucket.name,
      );
      expect(bucketGone).toEqual("gone");
      const appGone = yield* waitUntilAppGone(out.app.appName);
      expect(appGone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 120_000 },
);

const sanitizeReplaceName = (name: string): string => {
  const clipped = name.length >= 30 ? name.slice(0, 29) : name;
  return `${clipped}x`.replace(/[^a-z0-9-]/g, "-").slice(0, 63);
};
