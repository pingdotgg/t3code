import * as translate from "@distilled.cloud/gcp/translate_v3";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  DEFAULT_LOCATION,
  ResourceNotResolved,
  expandParent,
  normalizeLocation,
  parseResourceName,
  replaceOnIdentity,
  resourceNameOf,
  retryTransient,
  sameJson,
  sameText,
  waitUntilGone,
} from "./internal.ts";

export type GlossaryTermProps = {
  /**
   * Glossary term text.
   */
  text?: string;
  /**
   * BCP-47 language code for this term, for example `"en"`.
   */
  languageCode?: string;
};

export type GlossaryTermsPairProps = {
  /**
   * Source term matched in input text (unidirectional glossaries).
   */
  sourceTerm?: GlossaryTermProps;
  /**
   * Replacement term written into the translation.
   */
  targetTerm?: GlossaryTermProps;
};

export type GlossaryTermsSetProps = {
  /**
   * Equivalent terms that may replace each other (equivalent-term
   * glossaries).
   */
  terms?: GlossaryTermProps[];
};

export type GlossariesGlossaryEntryProps = {
  /**
   * Parent glossary resource name
   * `projects/{project}/locations/{location}/glossaries/{glossary}`
   * or the glossary id (combined with `location`). Immutable — changing
   * it replaces the entry.
   */
  parent: string;
  /**
   * Location used when `parent` is a bare glossary id. Immutable —
   * changing it replaces the entry.
   * @default "us-central1"
   */
  location?: string;
  /**
   * Server-assigned integer entry id (the `{entry}` segment of
   * `.../glossaries/{glossary}/glossaryEntries/{entry}`). Leave blank on
   * create. Immutable — changing it replaces the entry.
   */
  glossaryEntryId?: string;
  /**
   * Human-readable description.
   */
  description?: string;
  /**
   * Unidirectional source/target term pair. Mutually exclusive with
   * `termsSet`.
   */
  termsPair?: GlossaryTermsPairProps;
  /**
   * Equivalent term set. Mutually exclusive with `termsPair`.
   */
  termsSet?: GlossaryTermsSetProps;
};

export type GlossariesGlossaryEntry = Resource<
  "GCP.Translate.GlossariesGlossaryEntry",
  GlossariesGlossaryEntryProps,
  {
    /** Full resource name `projects/{project}/locations/{location}/glossaries/{glossary}/glossaryEntries/{entry}`. */
    name: string;
    /** Entry id (last path segment). */
    glossaryEntryId: string;
    /** Parent glossary resource name. */
    parent: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** Description. */
    description: string | undefined;
    /** Unidirectional term pair, if set. */
    termsPair: GlossaryTermsPairProps | undefined;
    /** Equivalent term set, if set. */
    termsSet: GlossaryTermsSetProps | undefined;
  },
  never,
  Providers
>;

/**
 * A single Cloud Translation glossary entry under a parent glossary.
 *
 * Without labels, ownership rests on the deterministic id: `read` reports a
 * resource it finds without prior state as unowned (adopt it with `--adopt`).
 * Entries are nested under a glossary and have no labels field. Term pair /
 * term set and description update in place via patch. Parent glossary and
 * entry id are identity — changing them replaces the entry.
 *
 * ### Creating an Entry
 * **Example:** Unidirectional term pair
 * ```typescript
 * const entry = yield* GCP.Translate.GlossariesGlossaryEntry("Hello", {
 *   parent: glossary.name,
 *   termsPair: {
 *     sourceTerm: { languageCode: "en", text: "hello" },
 *     targetTerm: { languageCode: "es", text: "hola" },
 *   },
 * });
 * ```
 *
 * **Example:** Description
 * ```typescript
 * const entry = yield* GCP.Translate.GlossariesGlossaryEntry("Hello", {
 *   parent: glossary.name,
 *   description: "greeting",
 *   termsPair: {
 *     sourceTerm: { languageCode: "en", text: "hello" },
 *     targetTerm: { languageCode: "es", text: "hola" },
 *   },
 * });
 * ```
 *
 * ### Updating an Entry
 * **Example:** Change the target term
 * ```typescript
 * // Same logical id as before; only the changed props differ.
 * const entry = yield* GCP.Translate.GlossariesGlossaryEntry("Hello", {
 *   parent: glossary.name,
 *   termsPair: {
 *     sourceTerm: { languageCode: "en", text: "hello" },
 *     targetTerm: { languageCode: "es", text: "buenas" },
 *   },
 * });
 * ```
 *
 * @resource
 * @category Translate
 */
export const GlossariesGlossaryEntry = Resource<GlossariesGlossaryEntry>(
  "GCP.Translate.GlossariesGlossaryEntry",
);

const toTerm = (
  term: translate.GlossaryTerm | undefined,
): GlossaryTermProps | undefined => {
  if (term === undefined) return undefined;
  return {
    text: term.text,
    languageCode: term.languageCode,
  };
};

const toTermsPair = (
  pair: translate.GlossaryTermsPair | undefined,
): GlossaryTermsPairProps | undefined => {
  if (pair === undefined) return undefined;
  return {
    sourceTerm: toTerm(pair.sourceTerm),
    targetTerm: toTerm(pair.targetTerm),
  };
};

const toTermsSet = (
  set: translate.GlossaryTermsSet | undefined,
): GlossaryTermsSetProps | undefined => {
  if (set === undefined) return undefined;
  return {
    terms: (set.terms ?? []).map((term) => ({
      text: term.text,
      languageCode: term.languageCode,
    })),
  };
};

const toAttrs = (entry: translate.GlossaryEntry, project: string) => {
  const name = entry.name ?? "";
  const parsed = parseResourceName(name, "glossaryEntries");
  return {
    name,
    glossaryEntryId: parsed.id,
    parent: parsed.parent,
    project: parsed.project || project,
    location: parsed.location,
    description: entry.description,
    termsPair: toTermsPair(entry.termsPair),
    termsSet: toTermsSet(entry.termsSet),
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : translate
        .getProjectsLocationsGlossariesGlossaryEntries({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const glossaryParentOf = (project: string, location: string, parent: string) =>
  expandParent(parent, project, location, "glossaries");

export const GlossariesGlossaryEntryProvider = () =>
  Provider.succeed(GlossariesGlossaryEntry, {
    stables: ["name", "glossaryEntryId", "parent", "project", "location"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousParent = olds?.parent ?? output?.parent;
      const nextParent = news.parent;
      return replaceOnIdentity({
        previousId: olds?.glossaryEntryId ?? output?.glossaryEntryId,
        nextId: news.glossaryEntryId,
        previousLocation: olds?.location ?? output?.location,
        nextLocation: news.location ?? olds?.location ?? output?.location,
        previousParent,
        nextParent,
      });
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(olds?.location ?? output?.location);
      const parent = glossaryParentOf(
        env.project,
        location,
        olds?.parent ?? output?.parent ?? "",
      );
      const glossaryEntryId = olds?.glossaryEntryId ?? output?.glossaryEntryId;
      const name =
        output?.name ??
        (glossaryEntryId
          ? resourceNameOf(parent, "glossaryEntries", glossaryEntryId)
          : "");
      // Server-assigned id: only a recorded entry can be observed.
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return output !== undefined ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ news, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        news.location ?? output?.location ?? DEFAULT_LOCATION,
      );
      const parent = glossaryParentOf(env.project, location, news.parent);
      if (
        parent.length === 0 ||
        parent.endsWith("/glossaries") ||
        parent.includes("/locations/global/")
      ) {
        return yield* new ResourceNotResolved({
          name: parent || news.parent,
        });
      }
      const glossaryEntryId = news.glossaryEntryId ?? output?.glossaryEntryId;
      const name = glossaryEntryId
        ? resourceNameOf(parent, "glossaryEntries", glossaryEntryId)
        : (output?.name ?? "");
      const description = news.description;
      const hinted = output?.name ?? name;
      const body: translate.GlossaryEntry = {
        ...(name.length > 0 ? { name } : {}),
        description,
        termsPair: news.termsPair,
        termsSet: news.termsSet,
      };

      let current = yield* getByName(hinted);

      if (current === undefined) {
        const created = yield* retryTransient(
          translate.createProjectsLocationsGlossariesGlossaryEntries({
            parent,
            body,
          }),
        ).pipe(Effect.catchTag("Conflict", () => getByName(name)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new ResourceNotResolved({ name: hinted || name });
      }

      const currentName = current.name ?? hinted;
      const descriptionChanged = !sameText(current.description, description);
      const pairChanged = !sameJson(current.termsPair, news.termsPair);
      const setChanged = !sameJson(current.termsSet, news.termsSet);
      if (descriptionChanged || pairChanged || setChanged) {
        current = yield* retryTransient(
          translate.patchProjectsLocationsGlossariesGlossaryEntries({
            name: currentName,
            body: {
              name: currentName,
              description,
              termsPair: news.termsPair,
              termsSet: news.termsSet,
            },
          }),
        );
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (!output.name) return;
      yield* retryTransient(
        translate.deleteProjectsLocationsGlossariesGlossaryEntries({
          name: output.name,
        }),
      ).pipe(Effect.catchTag("NotFound", () => Effect.void));
      yield* waitUntilGone(getByName(output.name), output.name);
    }),
  });
