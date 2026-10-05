import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as cci from "@distilled.cloud/gcp/contactcenterinsights_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { GcpEnvironment } from "@/GCP/Environment";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const waitUntilGone = (name: string) =>
  cci.getProjectsLocationsAuthorizedViewSetsAuthorizedViews({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsAuthorizedViewSetsAuthorizedViews on a missing view fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        cci.getProjectsLocationsAuthorizedViewSetsAuthorizedViews({
          name: `projects/${project}/locations/us-central1/authorizedViewSets/alchemy-missing-set/authorizedViews/alchemy-missing-view`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:contactcenterinsights", "live"],
    timeout: 90_000,
  },
);

// Needs Contact Center AI Insights features the testing project does not
// have enabled: creating the parent authorized view set returns 404 NOT_FOUND "Requested entity was not found."
test.provider.skipIf(!process.env.GCP_TEST_CCAI_QUALITY || !!process.env.FAST)(
  "create, update, and delete an authorized view",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const set = yield* GCP.ContactCenterInsights.AuthorizedViewSet(
            "QaViews",
            { displayName: "qa" },
          );
          const view =
            yield* GCP.ContactCenterInsights.AuthorizedViewSetsAuthorizedView(
              "Reviewers",
              {
                parent: set.name,
                displayName: "rv",
              },
            );
          return { set, view };
        }),
      );

      expect(created.view.authorizedViewId).toEqual(expect.any(String));
      expect(created.view.name).toContain("/authorizedViews/");
      expect(created.view.parent).toEqual(created.set.name);
      expect(created.view.displayName).toEqual("rv");

      const fetched =
        yield* cci.getProjectsLocationsAuthorizedViewSetsAuthorizedViews({
          name: created.view.name,
        });
      expect(fetched.name).toEqual(created.view.name);
      expect(fetched.displayName).toContain("alchemy-id=");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const set = yield* GCP.ContactCenterInsights.AuthorizedViewSet(
            "QaViews",
            {
              authorizedViewSetId: created.set.authorizedViewSetId,
              location: "us-central1",
              displayName: "qa",
            },
          );
          const view =
            yield* GCP.ContactCenterInsights.AuthorizedViewSetsAuthorizedView(
              "Reviewers",
              {
                parent: set.name,
                authorizedViewId: created.view.authorizedViewId,
                displayName: "rv-2",
                conversationFilter: 'agent_id="alchemy-agent"',
              },
            );
          return { set, view };
        }),
      );

      expect(updated.view.name).toEqual(created.view.name);
      expect(updated.view.displayName).toEqual("rv-2");
      expect(updated.view.conversationFilter).toEqual(
        'agent_id="alchemy-agent"',
      );

      const fetchedUpdate =
        yield* cci.getProjectsLocationsAuthorizedViewSetsAuthorizedViews({
          name: updated.view.name,
        });
      expect(fetchedUpdate.conversationFilter).toEqual(
        'agent_id="alchemy-agent"',
      );

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.view.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:contactcenterinsights", "live"],
    timeout: 90_000,
  },
);
