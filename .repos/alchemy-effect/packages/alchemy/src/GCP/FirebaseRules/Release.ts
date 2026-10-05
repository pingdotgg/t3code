import * as firebaserules from "@distilled.cloud/gcp/firebaserules_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  expandRulesetName,
  getRelease,
  isGeneratedReleaseId,
  listReleases,
  projectParent,
  releaseIdOf,
  releaseResourceName,
  sameText,
  toReleaseId,
} from "./internal.ts";

export type ReleaseProps = {
  /**
   * Release id (the `{release_id}` segment of
   * `projects/{project}/releases/{release_id}`). May contain `/` (e.g.
   * `cloud.firestore` or `prod/v23`). If omitted, a unique `alc-`
   * prefixed name is generated from the stack, stage, and logical id.
   * Firebase Rules releases have no labels field, so generated ids carry
   * the `alc-` prefix for `list` / nuke. Immutable — changing it
   * replaces the release.
   */
  releaseId?: string;
  /**
   * Ruleset this release points at
   * (`projects/{project}/rulesets/{rulesetId}` or a bare ruleset id).
   * The ruleset must exist. Updating this patches the release in place.
   */
  rulesetName: string;
};

export type Release = Resource<
  "GCP.FirebaseRules.Release",
  ReleaseProps,
  {
    /** Full resource name `projects/{project}/releases/{releaseId}`. */
    name: string;
    /** Release id (path after `/releases/`). */
    releaseId: string;
    /** Project id. */
    project: string;
    /** Full ruleset resource name this release refers to. */
    rulesetName: string;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A named Firebase Security Rules release pointing at a `Ruleset`.
 *
 * Releases have no labels field. Generated release ids are prefixed
 * `alc-` so `list` / nuke can find them. `releaseId` is identity —
 * changing it replaces the release. `rulesetName` updates in place.
 *
 * ### Creating a Release
 * **Example:** Generated id
 * ```typescript
 * const ruleset = yield* GCP.FirebaseRules.Ruleset("Firestore", {
 *   source: {
 *     files: [
 *       {
 *         name: "firestore.rules",
 *         content: "rules_version = '2'; service cloud.firestore { match /databases/{database}/documents { match /{document=**} { allow read, write: if false; } } }",
 *       },
 *     ],
 *   },
 * });
 * const release = yield* GCP.FirebaseRules.Release("Live", {
 *   rulesetName: ruleset.name,
 * });
 * ```
 *
 * **Example:** Named release
 * ```typescript
 * const release = yield* GCP.FirebaseRules.Release("Live", {
 *   releaseId: "prod",
 *   rulesetName: ruleset.name,
 * });
 * ```
 *
 * ### Updating a Release
 * **Example:** Point at a new ruleset
 * ```typescript
 * const release = yield* GCP.FirebaseRules.Release("Live", {
 *   rulesetName: nextRuleset.name,
 * });
 * ```
 *
 * @resource
 * @category FirebaseRules
 */
export const Release = Resource<Release>("GCP.FirebaseRules.Release");

export class ReleaseNotResolved extends Data.TaggedError(
  "GCP.FirebaseRules.ReleaseNotResolved",
)<{
  name: string;
}> {}

const toAttrs = (release: firebaserules.Release, project: string) => {
  const name = release.name ?? "";
  return {
    name,
    releaseId: releaseIdOf(name),
    project,
    rulesetName: release.rulesetName ?? "",
    createTime: release.createTime,
    updateTime: release.updateTime,
  };
};

export const ReleaseProvider = () =>
  Provider.succeed(Release, {
    stables: ["name", "releaseId", "project", "createTime"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previous = olds?.releaseId ?? output?.releaseId;
      if (
        news.releaseId !== undefined &&
        previous !== undefined &&
        news.releaseId !== previous
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const releaseId = yield* toReleaseId(
        id,
        olds?.releaseId,
        output?.releaseId,
      );
      const name = output?.name ?? releaseResourceName(env.project, releaseId);
      const existing = yield* getRelease(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      if (
        isGeneratedReleaseId(attrs.releaseId) ||
        output?.name === attrs.name
      ) {
        return attrs;
      }
      return Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const releases = yield* listReleases(env.project);
        return releases
          .filter((release) =>
            isGeneratedReleaseId(releaseIdOf(release.name ?? "")),
          )
          .map((release) => toAttrs(release, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const parent = projectParent(env.project);
      const releaseId = yield* toReleaseId(
        id,
        news.releaseId,
        output?.releaseId,
      );
      const name = releaseResourceName(env.project, releaseId);
      const desiredRuleset = expandRulesetName(env.project, news.rulesetName);

      let current = yield* getRelease(output?.name ?? name);

      if (current === undefined) {
        const created = yield* firebaserules
          .createProjectsReleases({
            name: parent,
            body: {
              name,
              rulesetName: desiredRuleset,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => getRelease(name)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new ReleaseNotResolved({ name });
      }

      if (!sameText(current.rulesetName, desiredRuleset)) {
        current = yield* firebaserules.patchProjectsReleases({
          name: current.name ?? name,
          body: {
            release: {
              name: current.name ?? name,
              rulesetName: desiredRuleset,
            },
            updateMask: "rulesetName",
          },
        });
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (!output.name) return;
      yield* firebaserules
        .deleteProjectsReleases({ name: output.name })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
