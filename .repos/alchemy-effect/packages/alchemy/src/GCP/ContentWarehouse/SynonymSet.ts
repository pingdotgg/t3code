import * as cw from "@distilled.cloud/gcp/contentwarehouse_v1";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  MAX_CONTEXT_LENGTH,
  ensureProject,
  locationParent,
  normalizeLocation,
  parseName,
  replaceOnIdentity,
  rfc1035,
  sameJson,
  sameText,
  toPhysicalId,
  userSynonyms,
  waitUntilExists,
  waitUntilGone,
  ResourceNotResolved,
} from "./internal.ts";

export type Synonym = cw.GoogleCloudContentwarehouseV1SynonymSetSynonym;

export type SynonymSetProps = {
  /**
   * Context id (the `{context}` segment of
   * `projects/{project}/locations/{location}/synonymSets/{context}`).
   * If omitted, a unique RFC1035 context is generated. Immutable —
   * changing it replaces the synonym set.
   */
  context?: string;
  /**
   * Multi-region location (`us` or `eu`). Immutable — changing it
   * replaces the synonym set. `US` is accepted and normalized to `us`.
   * @default "us"
   */
  location?: string;
  /**
   * Groups of synonymous words.
   */
  synonyms?: Synonym[];
};

export type SynonymSet = Resource<
  "GCP.ContentWarehouse.SynonymSet",
  SynonymSetProps,
  {
    /** Full resource name. */
    name: string;
    /** Context id (last path segment). */
    context: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** Synonym groups. */
    synonyms: Synonym[] | undefined;
  },
  never,
  Providers
>;

const DEFAULT_SYNONYMS: Synonym[] = [{ words: ["sale", "invoice", "bill"] }];

/**
 * A Document AI Warehouse synonym set — custom search synonyms for a
 * query context (`sales`, `engineering`, …).
 *
 * Synonym sets have no labels field; Alchemy identifies one by its
 * context. Without state, a set found under an explicit `context` is
 * reported as unowned. Context and location are immutable. Synonym groups update in place.
 *
 * ### Creating a Synonym Set
 * **Example:** Sales synonyms
 * ```typescript
 * const synonyms = yield* GCP.ContentWarehouse.SynonymSet("Sales", {
 *   context: "sales",
 *   synonyms: [{ words: ["sale", "invoice", "bill"] }],
 * });
 * ```
 *
 * @resource
 * @category ContentWarehouse
 */
export const SynonymSet = Resource<SynonymSet>(
  "GCP.ContentWarehouse.SynonymSet",
);

const resourceName = (project: string, location: string, context: string) =>
  `${locationParent(project, location)}/synonymSets/${context}`;

const contextOf = (
  id: string,
  explicit: string | undefined,
  existing: string | undefined,
) =>
  Effect.gen(function* () {
    if (explicit !== undefined) {
      return rfc1035(explicit, "sales").slice(0, MAX_CONTEXT_LENGTH);
    }
    if (existing !== undefined) return existing;
    return yield* toPhysicalId(id, undefined, undefined, "syn");
  });

const toAttrs = (
  item: cw.GoogleCloudContentwarehouseV1SynonymSet,
  project: string,
) => {
  const name = item.name ?? "";
  const parsed = parseName(name, "synonymSets");
  return {
    name,
    context: item.context ?? parsed.id,
    project: parsed.project || project,
    location: parsed.location,
    synonyms: userSynonyms(item.synonyms),
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : cw
        .getProjectsLocationsSynonymSets({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

export const SynonymSetProvider = () =>
  Provider.succeed(SynonymSet, {
    stables: ["name", "context", "project", "location"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      return replaceOnIdentity({
        previousId: olds?.context ?? output?.context,
        nextId: news.context,
        previousLocation: olds?.location ?? output?.location,
        nextLocation: news.location ?? olds?.location ?? output?.location,
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(olds?.location ?? output?.location);
      const context = yield* contextOf(id, olds?.context, output?.context);
      const existing = yield* getByName(
        output?.name ?? resourceName(env.project, location, context),
      );
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      // State or the generated context proves ownership.
      return output !== undefined || olds?.context === undefined
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(news.location ?? output?.location);
      const parent = locationParent(env.project, location);
      yield* ensureProject(parent);
      const context = yield* contextOf(id, news.context, output?.context);
      const name = resourceName(env.project, location, context);
      const synonyms = news.synonyms ?? DEFAULT_SYNONYMS;

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* cw
          .createProjectsLocationsSynonymSets({
            parent,
            body: { context, synonyms },
          })
          .pipe(Effect.catchTag("Conflict", () => getByName(name)));
        current = created ?? (yield* waitUntilExists(getByName(name), name));
      }

      if (current === undefined) {
        return yield* new ResourceNotResolved({ name });
      }

      const currentName = current.name ?? name;
      const contextChanged = !sameText(current.context, context);
      // `current.synonyms` may still hold an ownership group written by an
      // earlier version; comparing raw groups removes it on the next patch.
      const synonymsChanged = !sameJson(current.synonyms ?? [], synonyms);
      if (contextChanged || synonymsChanged) {
        current = yield* cw.patchProjectsLocationsSynonymSets({
          name: currentName,
          body: {
            name: currentName,
            context,
            synonyms,
          },
        });
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* cw
        .deleteProjectsLocationsSynonymSets({ name: output.name })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
      yield* waitUntilGone(getByName(output.name), output.name);
    }),
  });
