import * as firebaserules from "@distilled.cloud/gcp/firebaserules_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import { createInternalLabels } from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  findOwnedRuleset,
  getRuleset,
  listFullRulesets,
  listOwnedRulesets,
  ownedByAlchemy,
  projectParent,
  rulesetIdOf,
  sameText,
  sourceFingerprint,
  stampSource,
  toUserFiles,
  type RulesetFile,
  type RulesetSource,
} from "./internal.ts";

export type { RulesetFile, RulesetSource };

export type RulesetProps = {
  /**
   * Source files for this ruleset. Rulesets are immutable — changing
   * `source` replaces the ruleset. Firebase Rules has no labels field,
   * so Alchemy stamps ownership into a `// [alchemy …]` comment on the
   * first file and strips it from attributes.
   */
  source: RulesetSource;
  /**
   * Intended resource this ruleset should be released to, e.g.
   * `firestore.googleapis.com/projects/{project}/databases/(default)`.
   * May be left blank for the default release. Immutable — changing it
   * replaces the ruleset.
   */
  attachmentPoint?: string;
};

export type Ruleset = Resource<
  "GCP.FirebaseRules.Ruleset",
  RulesetProps,
  {
    /** Full resource name `projects/{project}/rulesets/{rulesetId}`. */
    name: string;
    /** Server-assigned ruleset id (last path segment). */
    rulesetId: string;
    /** Project id. */
    project: string;
    /** User source with the Alchemy ownership comment stripped. */
    source: RulesetSource;
    /** Services declared by this ruleset (`cloud.firestore`, …). */
    services: string[];
    /** Intended release attachment point, if set. */
    attachmentPoint: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * An immutable Firebase Security Rules ruleset.
 *
 * Rulesets have no labels field, so Alchemy stamps ownership into a
 * `// [alchemy …]` comment on the first source file for `list` / nuke.
 * Source and `attachmentPoint` are identity — changing either replaces
 * the ruleset. The ruleset id is assigned by the service.
 *
 * ### Creating a Ruleset
 * **Example:** Firestore rules
 * ```typescript
 * const ruleset = yield* GCP.FirebaseRules.Ruleset("Firestore", {
 *   source: {
 *     files: [{
 *       name: "firestore.rules",
 *       content: "rules_version = '2'; service cloud.firestore { match /databases/{database}/documents { match /{document=**} { allow read, write: if false; } } }",
 *     }],
 *   },
 * });
 * ```
 *
 * **Example:** Storage rules with an attachment point
 * ```typescript
 * const ruleset = yield* GCP.FirebaseRules.Ruleset("Storage", {
 *   attachmentPoint:
 *     "firebase.storage.googleapis.com/projects/my-project/buckets/my-bucket",
 *   source: {
 *     files: [{
 *       name: "storage.rules",
 *       content: "rules_version = '2'; service firebase.storage { match /b/{bucket}/o { match /{allPaths=**} { allow read, write: if false; } } }",
 *     }],
 *   },
 * });
 * ```
 *
 * ### Replacing a Ruleset
 * **Example:** New source (new ruleset id)
 * ```typescript
 * const ruleset = yield* GCP.FirebaseRules.Ruleset("Firestore", {
 *   source: {
 *     files: [{
 *       name: "firestore.rules",
 *       content: "rules_version = '2'; service cloud.firestore { match /databases/{database}/documents { match /{document=**} { allow read, write: if request.auth != null; } } }",
 *     }],
 *   },
 * });
 * ```
 *
 * @resource
 * @category FirebaseRules
 */
export const Ruleset = Resource<Ruleset>("GCP.FirebaseRules.Ruleset");

export class RulesetNotResolved extends Data.TaggedError(
  "GCP.FirebaseRules.RulesetNotResolved",
)<{
  name: string;
}> {}

const toAttrs = (ruleset: firebaserules.Ruleset, project: string) => {
  const name = ruleset.name ?? "";
  return {
    name,
    rulesetId: rulesetIdOf(name),
    project,
    source: { files: toUserFiles(ruleset.source?.files) },
    services: [...(ruleset.metadata?.services ?? [])],
    attachmentPoint: ruleset.attachmentPoint,
    createTime: ruleset.createTime,
  };
};

export const RulesetProvider = () =>
  Provider.succeed(Ruleset, {
    stables: ["name", "rulesetId", "project", "createTime"],

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news)) return undefined;
      if (output === undefined) return undefined;
      const sourceChanged =
        sourceFingerprint(news.source.files) !==
        sourceFingerprint(output.source.files);
      const attachmentChanged =
        news.attachmentPoint !== undefined &&
        (news.attachmentPoint ?? "") !== (output.attachmentPoint ?? "");
      if (!sourceChanged && !attachmentChanged) return undefined;
      return { action: "replace" as const, deleteFirst: false };
    }),

    read: Effect.fn(function* ({ id, output }) {
      const env = yield* GcpEnvironment.current;
      let existing = yield* getRuleset(output?.name ?? "");
      if (existing === undefined) {
        existing = yield* findOwnedRuleset(
          yield* listFullRulesets(env.project),
          id,
          output?.name,
        );
      }
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return (yield* ownedByAlchemy(id, existing.source))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const rulesets = yield* listOwnedRulesets(env.project);
        return rulesets.map((ruleset) => toAttrs(ruleset, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const parent = projectParent(env.project);
      const ownership = yield* createInternalLabels(id);
      const desiredSource = stampSource(news.source, ownership);

      let current = yield* getRuleset(output?.name ?? "");
      if (current === undefined) {
        const found = yield* findOwnedRuleset(
          yield* listFullRulesets(env.project),
          id,
          output?.name,
        );
        // Replacement uses the same logical id as the old generation. Only
        // reuse a scanned ruleset when source matches (crash-after-create);
        // a different source must become a new ruleset.
        if (
          found !== undefined &&
          (output?.name === found.name ||
            (sourceFingerprint(found.source?.files) ===
              sourceFingerprint(news.source.files) &&
              sameText(found.attachmentPoint, news.attachmentPoint)))
        ) {
          current = found;
        }
      }

      if (current === undefined) {
        const created = yield* firebaserules
          .createProjectsRulesets({
            name: parent,
            body: {
              source: desiredSource,
              attachmentPoint: news.attachmentPoint,
            },
          })
          .pipe(
            Effect.catchTag("Conflict", () =>
              listFullRulesets(env.project).pipe(
                Effect.flatMap((rulesets) =>
                  findOwnedRuleset(rulesets, id, undefined),
                ),
              ),
            ),
          );
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new RulesetNotResolved({
          name: output?.name ?? `${parent}/rulesets`,
        });
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (!output.name) return;
      yield* firebaserules.deleteProjectsRulesets({ name: output.name }).pipe(
        Effect.retry({
          while: (error) => error._tag === "Conflict",
          times: 8,
          schedule: Schedule.spaced("2 seconds"),
        }),
        Effect.catchTag("NotFound", () => Effect.void),
      );
    }),
  });
