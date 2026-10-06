import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as dataform from "@distilled.cloud/gcp/dataform_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { logLevel, currentProject, waitUntilGone } from "./common.ts";

const { test } = Test.make({ providers: GCP.providers() });

test.provider(
  "getProjectsLocationsTeamFolders on a missing team folder fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const project = yield* currentProject;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        dataform.getProjectsLocationsTeamFolders({
          name: `projects/${project}/locations/us-central1/teamFolders/alchemy-missing-team`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:dataform", "live"], timeout: 90_000 },
);

test.provider(
  "create, update, and delete a dataform team folder",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Dataform.Team("Analytics", {
            location: "us-central1",
            displayName: "analytics-team",
          });
        }),
      );

      expect(created.name).toContain("/teamFolders/");
      expect(created.location).toEqual("us-central1");
      expect(created.displayName).toEqual("analytics-team");

      const fetched = yield* dataform.getProjectsLocationsTeamFolders({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.displayName).toContain("analytics-team");
      expect(fetched.displayName).toMatch(/\[alc(hemy)? /);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Dataform.Team("Analytics", {
            location: "us-central1",
            displayName: "analytics-team-v2",
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.displayName).toEqual("analytics-team-v2");

      yield* stack.destroy();
      const gone = yield* waitUntilGone(
        dataform.getProjectsLocationsTeamFolders({ name: created.name }),
      );
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:dataform", "live"], timeout: 90_000 },
);
