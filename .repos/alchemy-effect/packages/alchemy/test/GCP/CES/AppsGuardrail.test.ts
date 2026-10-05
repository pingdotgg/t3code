import { GcpEnvironment } from "@/GCP/Environment";
import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as ces from "@distilled.cloud/gcp/ces_v1";
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
  ces.getProjectsLocationsAppsGuardrails({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsAppsGuardrails on a missing guardrail fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;

      yield* stack.destroy();

      const error = yield* Effect.flip(
        ces.getProjectsLocationsAppsGuardrails({
          name: `projects/${project}/locations/us/apps/missing/guardrails/missing`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:ces", "live"], timeout: 300_000 },
);

test.provider(
  "create, update, and delete a guardrail",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const app = yield* GCP.CES.App("Support", {
            location: "us",
            displayName: "support-guardrail",
          });
          const guardrail = yield* GCP.CES.AppsGuardrail("Safety", {
            app: app.name,
            displayName: "safety",
            description: "ban phrases",
            contentFilter: {
              matchType: "SIMPLE_STRING_MATCH",
              bannedContents: ["forbidden"],
            },
          });
          return { app, guardrail };
        }),
      );

      expect(created.guardrail.name).toContain("/guardrails/");
      expect(created.guardrail.app).toEqual(created.app.name);
      expect(created.guardrail.displayName).toEqual("safety");
      expect(created.guardrail.description).toEqual("ban phrases");
      expect(created.guardrail.contentFilter?.bannedContents).toContain(
        "forbidden",
      );

      const fetched = yield* ces.getProjectsLocationsAppsGuardrails({
        name: created.guardrail.name,
      });
      expect(fetched.name).toEqual(created.guardrail.name);
      expect(fetched.description).toContain("alchemy-id=");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const app = yield* GCP.CES.App("Support", {
            appId: created.app.appId,
            location: created.app.location,
            displayName: "support-guardrail",
          });
          const guardrail = yield* GCP.CES.AppsGuardrail("Safety", {
            app: app.name,
            guardrailId: created.guardrail.guardrailId,
            displayName: "safety",
            description: "ban more phrases",
            contentFilter: {
              matchType: "SIMPLE_STRING_MATCH",
              bannedContents: ["forbidden", "blocked"],
            },
          });
          return { app, guardrail };
        }),
      );

      expect(updated.guardrail.name).toEqual(created.guardrail.name);
      expect(updated.guardrail.description).toEqual("ban more phrases");
      expect(updated.guardrail.contentFilter?.bannedContents).toContain(
        "blocked",
      );

      yield* stack.destroy();
      const gone = yield* waitUntilGone(created.guardrail.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:ces", "live"], timeout: 300_000 },
);
