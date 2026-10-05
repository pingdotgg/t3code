import * as speech from "@distilled.cloud/gcp/speech_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  DEFAULT_LOCATION,
  deletePhraseSet,
  getPhraseSet,
  listOwnedPhraseSets,
  locationParent,
  markerFromPhrases,
  normalizeLocation,
  parseResourceName,
  type Phrase,
  replaceOnIdentity,
  resourceNameOf,
  sameNumber,
  samePhrases,
  stripOwnershipPhrases,
  toPhysicalId,
  updateMaskOf,
  waitUntilGone,
} from "./internal.ts";

export type { Phrase };

export type PhraseSetProps = {
  /**
   * Speech-to-Text Adaptation location. The global Speech endpoint
   * accepts `global`; `us` and `eu` need matching regional endpoints.
   * Immutable — changing it replaces the phrase set.
   * @default "global"
   */
  location?: string;
  /**
   * Phrase set id (the `{phrase_set}` segment of
   * `projects/{project}/locations/{location}/phraseSets/{phrase_set}`).
   * If omitted, a unique id is generated. Letters, numbers, and hyphens;
   * 4-63 characters; must start with a letter. Immutable — changing it
   * replaces the phrase set.
   */
  phraseSetId?: string;
  /**
   * Phrase hints. Phrase values can reference a custom class as
   * `${custom_class_id}`.
   */
  phrases?: Phrase[];
  /**
   * Hint boost applied to every phrase that does not set its own boost.
   * Typical values are between 0 (exclusive) and 20.
   */
  boost?: number;
};

export type PhraseSet = Resource<
  "GCP.Speech.PhraseSet",
  PhraseSetProps,
  {
    /** Full resource name `projects/{project}/locations/{location}/phraseSets/{phrase_set}`. */
    name: string;
    /** Phrase set id (last path segment). */
    phraseSetId: string;
    /** Project id. */
    project: string;
    /** Adaptation location. */
    location: string;
    /** Phrase hints. */
    phrases: Phrase[];
    /** Phrase-set-level hint boost. */
    boost: number | undefined;
    /** Server-assigned uid, if present. */
    uid: string | undefined;
    /** Lifecycle state, if present. */
    state: string | undefined;
    /** KMS key encrypting phrase set content, if any. */
    kmsKeyName: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Speech-to-Text Adaptation phrase set. Phrase sets bias recognition
 * toward listed words and phrases, including references to custom
 * classes (`${custom_class_id}`).
 *
 * Speech-to-Text v1 phrase sets have no labels field and Alchemy does
 * not write ownership into the phrases (they bias recognition). A
 * generated id identifies the set; one with an explicit id that Alchemy
 * has no state for is reported as unowned. Location and
 * phrase set id are identity — changing either replaces the set.
 * `phrases` and `boost` update in place.
 *
 * ### Creating a Phrase Set
 * **Example:** Generated id
 * ```typescript
 * const hints = yield* GCP.Speech.PhraseSet("Hints", {
 *   phrases: [{ value: "weather", boost: 10 }],
 *   boost: 5,
 * });
 * ```
 *
 * **Example:** Explicit id with a custom class reference
 * ```typescript
 * const hints = yield* GCP.Speech.PhraseSet("Hints", {
 *   phraseSetId: "weather-hints",
 *   phrases: [{ value: "sail on ${passenger-ships}" }],
 * });
 * ```
 *
 * ### Updating a Phrase Set
 * **Example:** Add a phrase and change boost
 * ```typescript
 * const hints = yield* GCP.Speech.PhraseSet("Hints", {
 *   phrases: [
 *     { value: "weather", boost: 15 },
 *     { value: "forecast" },
 *   ],
 *   boost: 8,
 * });
 * ```
 *
 * @resource
 * @category Speech
 */
export const PhraseSet = Resource<PhraseSet>("GCP.Speech.PhraseSet");

export class PhraseSetNotResolved extends Data.TaggedError(
  "GCP.Speech.PhraseSetNotResolved",
)<{
  name: string;
}> {}

const phraseSetNameOf = (
  project: string,
  location: string,
  phraseSetId: string,
) => resourceNameOf(project, location, "phraseSets", phraseSetId);

const toAttrs = (phraseSet: speech.PhraseSet, project: string) => {
  const name = phraseSet.name ?? "";
  const parsed = parseResourceName(name, "phraseSets");
  return {
    name,
    phraseSetId: parsed.id,
    // Speech echoes names with the project number; report the project id.
    project,
    location: parsed.location,
    phrases: stripOwnershipPhrases(phraseSet.phrases),
    boost: phraseSet.boost,
    uid: phraseSet.uid,
    state: phraseSet.state,
    kmsKeyName: phraseSet.kmsKeyName,
  };
};

export const PhraseSetProvider = () =>
  Provider.succeed(PhraseSet, {
    stables: ["name", "phraseSetId", "project", "location", "uid"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      return replaceOnIdentity({
        previousId: olds?.phraseSetId ?? output?.phraseSetId,
        nextId: news.phraseSetId,
        previousLocation: olds?.location ?? output?.location,
        nextLocation: news.location ?? olds?.location ?? output?.location,
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(olds?.location ?? output?.location);
      const phraseSetId = yield* toPhysicalId(
        id,
        olds?.phraseSetId,
        output?.phraseSetId,
      );
      const existing = yield* getPhraseSet(
        output?.name ?? phraseSetNameOf(env.project, location, phraseSetId),
      );
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      // No labels: a generated id derives from this stack, stage, logical
      // id and instance; an explicit id is only ours when state has it.
      return output !== undefined || olds?.phraseSetId === undefined
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const phraseSets = yield* listOwnedPhraseSets(env.project);
        return phraseSets.map((phraseSet) => toAttrs(phraseSet, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        news.location ?? output?.location ?? DEFAULT_LOCATION,
      );
      const phraseSetId = yield* toPhysicalId(
        id,
        news.phraseSetId,
        output?.phraseSetId,
      );
      const phrases = news.phrases ?? [];
      const name =
        output?.name ?? phraseSetNameOf(env.project, location, phraseSetId);

      let current = yield* getPhraseSet(name);

      if (current === undefined) {
        const created = yield* speech
          .createProjectsLocationsPhraseSets({
            parent: locationParent(env.project, location),
            body: {
              phraseSetId,
              phraseSet: {
                phrases,
                boost: news.boost,
              },
            },
          })
          .pipe(
            Effect.catchTag("Conflict", () =>
              getPhraseSet(phraseSetNameOf(env.project, location, phraseSetId)),
            ),
          );
        current = created ?? undefined;
        if (current?.name) {
          current = (yield* getPhraseSet(current.name)) ?? current;
        }
      }

      if (current === undefined) {
        return yield* new PhraseSetNotResolved({
          name: name || phraseSetNameOf(env.project, location, phraseSetId),
        });
      }

      const currentName = current.name ?? name;
      const updateMask = updateMaskOf(
        markerFromPhrases(current.phrases) === undefined &&
          samePhrases(current.phrases, news.phrases)
          ? undefined
          : "phrases",
        sameNumber(current.boost, news.boost) ? undefined : "boost",
      );
      if (updateMask.length > 0) {
        current = yield* speech.patchProjectsLocationsPhraseSets({
          name: currentName,
          updateMask,
          body: {
            name: currentName,
            phrases,
            boost: news.boost,
          },
        });
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (!output.name) return;
      yield* deletePhraseSet(output.name);
      yield* waitUntilGone(getPhraseSet(output.name));
    }),
  });
