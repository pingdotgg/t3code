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
  organizationOf,
  ownedByAlchemy,
  parseOwnership,
  replaceOnIdentity,
  resolveOrganization,
  toResourceId,
  tryResolveOrganization,
  updateMaskOf,
  waitForStoredInfoTypeReady,
} from "./internal.ts";

type StoredInfoTypeConfig = dlp.GooglePrivacyDlpV2StoredInfoTypeConfig;
type StoredInfoTypeRegex = dlp.GooglePrivacyDlpV2Regex;
type StoredInfoTypeDictionary = dlp.GooglePrivacyDlpV2Dictionary;
type StoredInfoTypeLargeCustomDictionary =
  dlp.GooglePrivacyDlpV2LargeCustomDictionaryConfig;

export type OrganizationStoredInfoTypeProps = {
  /**
   * StoredInfoType id (the `{storedInfoType}` segment of
   * `organizations/{organization}/storedInfoTypes/{storedInfoType}`). If
   * omitted, a unique name is generated. Must match `[a-zA-Z0-9_-]+` and
   * is at most 100 characters. Immutable — changing it replaces the
   * stored info type.
   */
  storedInfoTypeId?: string;
  /**
   * Parent organization (`organizations/{organization}` or the numeric
   * id). Defaults to the project ancestor organization. Immutable —
   * changing it replaces the stored info type.
   */
  organization?: string;
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

export type OrganizationStoredInfoType = Resource<
  "GCP.DLP.OrganizationStoredInfoType",
  OrganizationStoredInfoTypeProps,
  {
    /** Full resource name `organizations/{organization}/storedInfoTypes/{id}`. */
    name: string;
    /** StoredInfoType id (last path segment). */
    storedInfoTypeId: string;
    /** Organization resource name. */
    organization: string;
    /** Organization id. */
    organizationId: string;
    /** Project id of the deploying stack. */
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
 * An organization-scoped Cloud DLP stored info type.
 *
 * Stored info types have no labels field, so Alchemy stamps ownership
 * into the config description for `list` / nuke. Organization and id are
 * identity — changing them replaces the resource. Display name,
 * description, and detector config update in place (a new version).
 *
 * ### Creating a Stored Info Type
 * **Example:** Organization regex detector
 * ```typescript
 * const infoType = yield* GCP.DLP.OrganizationStoredInfoType("EmployeeId", {
 *   displayName: "employee ids",
 *   description: "badge numbers",
 *   regex: { pattern: "EMP[0-9]{6}" },
 * });
 * ```
 *
 * ### Updating a Stored Info Type
 * **Example:** Change the pattern
 * ```typescript
 * const infoType = yield* GCP.DLP.OrganizationStoredInfoType("EmployeeId", {
 *   displayName: "employee ids",
 *   description: "badge numbers v2",
 *   regex: { pattern: "EMP[0-9]{8}" },
 * });
 * ```
 *
 * @resource
 * @category DLP
 */
export const OrganizationStoredInfoType = Resource<OrganizationStoredInfoType>(
  "GCP.DLP.OrganizationStoredInfoType",
);

export class OrganizationStoredInfoTypeNotResolved extends Data.TaggedError(
  "GCP.DLP.OrganizationStoredInfoTypeNotResolved",
)<{
  name: string;
}> {}

const resourceName = (organization: string, storedInfoTypeId: string) =>
  `${organization}/storedInfoTypes/${storedInfoTypeId}`;

const configOf = (
  props: OrganizationStoredInfoTypeProps,
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
  organization: string,
  project: string,
) => {
  const name = stored.name ?? "";
  const config = stored.currentVersion?.config;
  const parsed = parseOwnership(config?.description);
  return {
    name,
    storedInfoTypeId: lastSegment(name),
    organization,
    organizationId: organizationOf(name) || lastSegment(organization),
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
        .getOrganizationsStoredInfoTypes({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

export const OrganizationStoredInfoTypeProvider = () =>
  Provider.succeed(OrganizationStoredInfoType, {
    stables: [
      "name",
      "storedInfoTypeId",
      "organization",
      "organizationId",
      "project",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousId = olds?.storedInfoTypeId ?? output?.storedInfoTypeId;
      const idChanged =
        previousId !== undefined &&
        news.storedInfoTypeId !== undefined &&
        news.storedInfoTypeId !== previousId;
      const previousOrg = olds?.organization ?? output?.organization;
      const orgChanged =
        previousOrg !== undefined &&
        news.organization !== undefined &&
        news.organization !== previousOrg;
      return replaceOnIdentity(idChanged || orgChanged);
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const organization = yield* resolveOrganization(
        olds?.organization ?? output?.organization,
        output?.organization,
      );
      const storedInfoTypeId = yield* toResourceId(
        id,
        olds?.storedInfoTypeId,
        output?.storedInfoTypeId,
      );
      const name = output?.name ?? resourceName(organization, storedInfoTypeId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, organization, env.project);
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
        const organization = yield* tryResolveOrganization();
        if (organization === undefined) return [];
        const items = yield* collectPages(
          dlp.listOrganizationsStoredInfoTypes.pages({
            parent: organization,
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
          .map((stored) => toAttrs(stored, organization, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const organization = yield* resolveOrganization(
        news.organization,
        output?.organization,
      );
      const storedInfoTypeId = yield* toResourceId(
        id,
        news.storedInfoTypeId,
        output?.storedInfoTypeId,
      );
      const name = resourceName(organization, storedInfoTypeId);
      const ownership = yield* createInternalLabels(id);
      const description = encodeOwnership(ownership, news.description);
      const config = configOf(news, description);

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* dlp
          .createOrganizationsStoredInfoTypes({
            parent: organization,
            body: {
              storedInfoTypeId,
              config,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => getByName(name)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new OrganizationStoredInfoTypeNotResolved({ name });
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
        current = yield* dlp.patchOrganizationsStoredInfoTypes({
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
      return toAttrs(current, organization, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* dlp
        .deleteOrganizationsStoredInfoTypes({ name: output.name })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
