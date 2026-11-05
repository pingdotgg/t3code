import * as firebaserules from "@distilled.cloud/gcp/firebaserules_v1";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as GCPBindings from "../GCPBindings.ts";
import { GetReleaseExecutable, type GetReleaseExecutableRequest } from "./GetReleaseExecutable.ts";
import type { Release } from "./Release.ts";

/**
 * HTTP implementation of {@link GetReleaseExecutable}.
 *
 * Grants `roles/firebaserules.admin` on the project because it is the
 * narrowest predefined role containing `firebaserules.releases.getExecutable`, and Firebase
 * Rules has no resource-level IAM.
 *
 * @layer
 * @provides GCP.FirebaseRules.GetReleaseExecutable
 */
export const GetReleaseExecutableHttp = Layer.effect(
  GetReleaseExecutable,
  Effect.gen(function* () {
    const bind = yield* GCPBindings.Bind;
    const getExecutableProjectsReleases = yield* GCPBindings.withCredentials(
      firebaserules.getExecutableProjectsReleases,
    );
    return Effect.fn(function* (release: Release) {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* bind`GCP.FirebaseRules.GetReleaseExecutable(${release})`({
          iam: [{ role: "roles/firebaserules.admin" }],
        });
      }
      const name = yield* release.name;
      return Effect.fn(`GCP.FirebaseRules.GetReleaseExecutable(${release.LogicalId})`)(function* (
        request: GetReleaseExecutableRequest = {},
      ) {
        return yield* getExecutableProjectsReleases({
          ...request,
          name: yield* name,
        });
      });
    });
  }),
);
