import * as dlp from "@distilled.cloud/gcp/dlp_v2";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import { createInternalLabels } from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  collectPages,
  encodeOwnership,
  hasOwnershipMarker,
  jsonEqual,
  lastSegment,
  ownedByAlchemy,
  parseOwnership,
  replaceOnIdentity,
  toResourceId,
  updateMaskOf,
  waitForStoredInfoTypeReady,
} from "./internal.ts";

type StoredInfoTypeRegex = dlp.GooglePrivacyDlpV2Regex;
type StoredInfoTypeDictionary = dlp.GooglePrivacyDlpV2Dictionary;
type StoredInfoTypeLargeCustomDictionary =
  dlp.GooglePrivacyDlpV2LargeCustomDictionaryConfig;

export type StoredInfoTypeProps = {
  /**
   * StoredInfoType id (the `{storedInfoType}` segment of
   * `projects/{project}/storedInfoTypes/{storedInfoType}`). If omitted, a
   * unique name is generated. Must match `[a-zA-Z0-9_-]+` and is at most
   * 100 characters. Immutable — changing it replaces the stored info type.
   */
  storedInfoTypeId?: string;
  /**
   * Display name (max 256 characters).
   */
  displayName?: string;
  /**
   * Human-readable description (max 256 characters). Stored info types
   * have no labels field, so Alchemy ownership is stored in a
   * `[alchemy …]` prefix and stripped from attributes.
   */
  description?: string;
  /**
   * Regular-expression detector. Use this or `dictionary` /
   * `largeCustomDictionary`.
   */
  regex?: StoredInfoTypeRegex;
  /**
   * Small word-list dictionary detector.
   */
  dictionary?: StoredInfoTypeDictionary;
  /**
   * Large custom dictionary built from Cloud Storage or BigQuery.
   */
  largeCustomDictionary?: StoredInfoTypeLargeCustomDictionary;
};

export type StoredInfoType = Resource<
  "GCP.DLP.StoredInfoType",
  StoredInfoTypeProps,
  {
    /** Full resource name `projects/{project}/storedInfoTypes/{id}`. */
    name: string;
    /** StoredInfoType id (last path segment). */
    storedInfoTypeId: string;
    /** Project id. */
    project: string;
    /** Display name. */
    displayName: string | undefined;
    /** User description with the Alchemy ownership prefix stripped. */
    description: string | undefined;
    /** Regular-expression detector, if set. */
    regex: StoredInfoTypeRegex | undefined;
    /** Word-list dictionary detector, if set. */
    dictionary: StoredInfoTypeDictionary | undefined;
    /** Large custom dictionary, if set. */
    largeCustomDictionary: StoredInfoTypeLargeCustomDictionary | undefined;
    /** Current version state (`READY`, `PENDING`, …). */
    state: string | undefined;
    /** RFC3339 creation timestamp of the current version. */
    createTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A project-scoped Cloud DLP stored info type
 * (`projects.storedInfoTypes`, global processing location).
 *
 * Stored info types have no labels field, so Alchemy stamps ownership
 * into the config description for `list` / nuke. Id is identity —
 * changing it replaces the resource. Display name, description, and
 * detector config update in place (a new version).
 *
 * ### Creating a Stored Info Type
 * **Example:** Project regex detector
 * ```typescript
 * const infoType = yield* GCP.DLP.StoredInfoType("Account", {
 *   displayName: "account ids",
 *   description: "internal account numbers",
 *   regex: { pattern: "ACCT[0-9]{8}" },
 * });
 * ```
 *
 * ### Updating a Stored Info Type
 * **Example:** Change the pattern
 * ```typescript
 * const infoType = yield* GCP.DLP.StoredInfoType("Account", {
 *   displayName: "account ids",
 *   description: "internal account numbers v2",
 *   regex: { pattern: "ACCT[0-9]{10}" },
 * });
 * ```
 *
 * @resource
 * @category DLP
 */
export const StoredInfoType = Resource<StoredInfoType>(
  "GCP.DLP.StoredInfoType",
);

export class StoredInfoTypeNotResolved extends Data.TaggedError(
  "GCP.DLP.StoredInfoTypeNotResolved",
)<{
  name: string;
}> {}

const resourceName = (project: string, storedInfoTypeId: string) =>
  `projects/${project}/storedInfoTypes/${storedInfoTypeId}`;

const configOf = (
  props: StoredInfoTypeProps,
  description: string,
): dlp.GooglePrivacyDlpV2StoredInfoTypeConfig => ({
  displayName: props.displayName,
  description,
  regex: props.regex,
  dictionary: props.dictionary,
  largeCustomDictionary: props.largeCustomDictionary,
});

const toAttrs = (
  stored: dlp.GooglePrivacyDlpV2StoredInfoType,
  project: string,
) => {
  const name = stored.name ?? "";
  const config = stored.currentVersion?.config;
  const parsed = parseOwnership(config?.description);
  return {
    name,
    storedInfoTypeId: lastSegment(name),
    project,
    displayName: config?.displayName,
    description: parsed.text,
    regex: config?.regex,
    dictionary: config?.dictionary,
    largeCustomDictionary: config?.largeCustomDictionary,
    state: stored.currentVersion?.state,
    createTime: stored.currentVersion?.createTime,
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : dlp
        .getProjectsStoredInfoTypes({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

export const StoredInfoTypeProvider = () =>
  Provider.succeed(StoredInfoType, {
    stables: ["name", "storedInfoTypeId", "project"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousId = olds?.storedInfoTypeId ?? output?.storedInfoTypeId;
      const idChanged =
        previousId !== undefined &&
        news.storedInfoTypeId !== undefined &&
        news.storedInfoTypeId !== previousId;
      return replaceOnIdentity(idChanged);
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const storedInfoTypeId = yield* toResourceId(
        id,
        olds?.storedInfoTypeId,
        output?.storedInfoTypeId,
      );
      const name = output?.name ?? resourceName(env.project, storedInfoTypeId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return (yield* ownedByAlchemy(
        id,
        existing.currentVersion?.config?.description,
      ))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const items = yield* collectPages(
          dlp.listProjectsStoredInfoTypes.pages({
            parent: `projects/${env.project}`,
            pageSize: 100,
          }),
          (page) => page.storedInfoTypes,
        ).pipe(
          Effect.catchTag("NotFound", () =>
            Effect.succeed([] as dlp.GooglePrivacyDlpV2StoredInfoType[]),
          ),
        );
        return items
          .filter((stored) =>
            hasOwnershipMarker(stored.currentVersion?.config?.description),
          )
          .map((stored) => toAttrs(stored, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const storedInfoTypeId = yield* toResourceId(
        id,
        news.storedInfoTypeId,
        output?.storedInfoTypeId,
      );
      const name = resourceName(env.project, storedInfoTypeId);
      const ownership = yield* createInternalLabels(id);
      const description = encodeOwnership(ownership, news.description);
      const config = configOf(news, description);

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* dlp
          .createProjectsStoredInfoTypes({
            parent: `projects/${env.project}`,
            body: {
              storedInfoTypeId,
              config,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => getByName(name)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new StoredInfoTypeNotResolved({ name });
      }

      const observed = current.currentVersion?.config;
      const displayChanged = !jsonEqual(
        observed?.displayName,
        news.displayName,
      );
      const descriptionChanged = (observed?.description ?? "") !== description;
      const regexChanged = !jsonEqual(observed?.regex, news.regex);
      const dictionaryChanged = !jsonEqual(
        observed?.dictionary,
        news.dictionary,
      );
      const largeChanged = !jsonEqual(
        observed?.largeCustomDictionary,
        news.largeCustomDictionary,
      );

      if (
        displayChanged ||
        descriptionChanged ||
        regexChanged ||
        dictionaryChanged ||
        largeChanged
      ) {
        current = yield* dlp.patchProjectsStoredInfoTypes({
          name: current.name ?? name,
          body: {
            config,
            updateMask: updateMaskOf(
              displayChanged ? "displayName" : undefined,
              descriptionChanged ? "description" : undefined,
              regexChanged ? "regex" : undefined,
              dictionaryChanged ? "dictionary" : undefined,
              largeChanged ? "largeCustomDictionary" : undefined,
            ),
          },
        });
      }

      const readyName = current.name ?? name;
      current = yield* waitForStoredInfoTypeReady(
        readyName,
        getByName(readyName),
      );
      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* dlp
        .deleteProjectsStoredInfoTypes({ name: output.name })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
