import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as apikeys from "@distilled.cloud/gcp/apikeys_v2";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const waitUntilGone = (name: string) =>
  apikeys.getProjectsLocationsKeys({ name }).pipe(
    Effect.map((key) =>
      (key.deleteTime ?? "") !== "" ? ("gone" as const) : ("found" as const),
    ),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "create, update, and delete an API key",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.ApiKeys.Key("Maps", {
            displayName: "alchemy test maps",
            annotations: { env: "test" },
          });
        }),
      );

      expect(created.name).toContain("/locations/global/keys/");
      expect(created.keyId).toEqual(expect.any(String));
      expect(created.location).toEqual("global");
      expect(created.displayName).toEqual("alchemy test maps");
      expect(created.annotations).toMatchObject({ env: "test" });
      expect(created.keyString).toEqual(expect.any(String));
      expect((created.keyString ?? "").length).toBeGreaterThan(0);

      const fetched = yield* apikeys.getProjectsLocationsKeys({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.displayName).toEqual("alchemy test maps");
      expect(fetched.annotations?.env).toEqual("test");
      expect(fetched.annotations?.["alchemy-id"]).toEqual(expect.any(String));
      expect(fetched.deleteTime).toBeFalsy();

      const keyString = yield* apikeys.getKeyStringProjectsLocationsKeys({
        name: created.name,
      });
      expect(keyString.keyString).toEqual(created.keyString);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.ApiKeys.Key("Maps", {
            keyId: created.keyId,
            displayName: "alchemy test maps v2",
            annotations: { env: "prod", role: "maps" },
            restrictions: {
              apiTargets: [{ service: "geocoding-backend.googleapis.com" }],
            },
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.keyId).toEqual(created.keyId);
      expect(updated.displayName).toEqual("alchemy test maps v2");
      expect(updated.annotations).toMatchObject({ env: "prod", role: "maps" });
      expect(updated.restrictions?.apiTargets?.[0]?.service).toEqual(
        "geocoding-backend.googleapis.com",
      );
      expect(updated.keyString).toEqual(created.keyString);

      const fetchedUpdate = yield* apikeys.getProjectsLocationsKeys({
        name: created.name,
      });
      expect(fetchedUpdate.displayName).toEqual("alchemy test maps v2");
      expect(fetchedUpdate.annotations?.env).toEqual("prod");
      expect(fetchedUpdate.annotations?.role).toEqual("maps");
      expect(fetchedUpdate.annotations?.["alchemy-id"]).toEqual(
        expect.any(String),
      );
      expect(fetchedUpdate.restrictions?.apiTargets?.[0]?.service).toEqual(
        "geocoding-backend.googleapis.com",
      );

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:apikeys", "live"], timeout: 90_000 },
);
