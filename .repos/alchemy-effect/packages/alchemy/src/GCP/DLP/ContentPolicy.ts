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
  DEFAULT_REGIONAL_LOCATION,
  MAX_CONTENT_POLICY_DISPLAY_NAME_LENGTH,
  collectPages,
  encodeOwnershipLine,
  hasOwnershipMarker,
  jsonEqual,
  lastSegment,
  locationOf,
  locationParent,
  normalizeLocation,
  ownedByAlchemy,
  parseOwnership,
  projectOf,
  replaceOnIdentity,
  toResourceId,
  updateMaskOf,
} from "./internal.ts";

export type PolicyRule = dlp.GooglePrivacyDlpV2PolicyRule;
export type PolicyAction = dlp.GooglePrivacyDlpV2PolicyAction;
export type LoggingConfig = dlp.GooglePrivacyDlpV2LoggingConfig;

export type ContentPolicyProps = {
  /**
   * Content policy id (the `{contentPolicy}` segment of
   * `projects/{project}/locations/{location}/contentPolicies/{id}`). If
   * omitted, a unique name is generated. Must match `[a-zA-Z0-9_-]+` and
   * is at most 100 characters. Immutable — changing it replaces the
   * policy.
   */
  contentPolicyId?: string;
  /**
   * Processing location (`us`, `us-central1`, …). Immutable — changing it
   * replaces the policy.
   * @default "us"
   */
  location?: string;
  /**
   * Display name (max 63 characters). Content policies have no labels or
   * description field, so Alchemy ownership is stored in a `[alchemy …]`
   * prefix and stripped from attributes.
   */
  displayName?: string;
  /**
   * Inspection configuration used to produce findings.
   */
  inspectConfig?: dlp.GooglePrivacyDlpV2InspectConfig;
  /**
   * Policy rules. The first matching rule applies.
   */
  rules?: PolicyRule[];
  /**
   * Action when no rule matches. Defaults to ALLOW.
   */
  defaultAction?: PolicyAction;
  /**
   * Action when the content is an unsupported file type.
   */
  unsupportedFileType?: PolicyAction;
  /**
   * Action when the content is a supported file type but too large.
   */
  inputTooLarge?: PolicyAction;
  /**
   * Action when a supported file fails to scan.
   */
  failedToScanSupportedFileType?: PolicyAction;
  /**
   * Optional logging configuration (for example BigQuery).
   */
  loggingConfigs?: LoggingConfig[];
};

export type ContentPolicy = Resource<
  "GCP.DLP.ContentPolicy",
  ContentPolicyProps,
  {
    /** Full resource name. */
    name: string;
    /** Content policy id (last path segment). */
    contentPolicyId: string;
    /** Location id. */
    location: string;
    /** Project id. */
    project: string;
    /** User display name with the Alchemy ownership prefix stripped. */
    displayName: string | undefined;
    /** Inspection configuration. */
    inspectConfig: dlp.GooglePrivacyDlpV2InspectConfig | undefined;
    /** Policy rules. */
    rules: PolicyRule[];
    /** Default action. */
    defaultAction: PolicyAction | undefined;
    /** Unsupported file type action. */
    unsupportedFileType: PolicyAction | undefined;
    /** Input too large action. */
    inputTooLarge: PolicyAction | undefined;
    /** Failed-to-scan action. */
    failedToScanSupportedFileType: PolicyAction | undefined;
    /** Logging configs. */
    loggingConfigs: LoggingConfig[];
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A location-scoped Cloud DLP content policy.
 *
 * Content policies have no labels field, so Alchemy stamps ownership
 * into the display name for `list` / nuke. Location and id are identity
 * — changing them replaces the policy. Display name, inspect config, and
 * rules update in place.
 *
 * ### Creating a Content Policy
 * **Example:** Block email addresses
 * ```typescript
 * const policy = yield* GCP.DLP.ContentPolicy("BlockEmail", {
 *   displayName: "block-email",
 *   inspectConfig: { infoTypes: [{ name: "EMAIL_ADDRESS" }] },
 *   rules: [
 *     {
 *       conditions: [
 *         {
 *           infoTypeCondition: {
 *             infoTypes: { infoTypeNames: ["EMAIL_ADDRESS"] },
 *           },
 *         },
 *       ],
 *       action: { returnVerdict: "BLOCK" },
 *     },
 *   ],
 *   defaultAction: { returnVerdict: "ALLOW" },
 * });
 * ```
 *
 * @resource
 * @category DLP
 */
export const ContentPolicy = Resource<ContentPolicy>("GCP.DLP.ContentPolicy");

export class ContentPolicyNotResolved extends Data.TaggedError(
  "GCP.DLP.ContentPolicyNotResolved",
)<{
  name: string;
}> {}

const resourceName = (
  project: string,
  location: string,
  contentPolicyId: string,
) => `${locationParent(project, location)}/contentPolicies/${contentPolicyId}`;

const toAttrs = (
  policy: dlp.GooglePrivacyDlpV2ContentPolicy,
  project: string,
) => {
  const name = policy.name ?? "";
  const parsed = parseOwnership(policy.displayName);
  return {
    name,
    contentPolicyId: lastSegment(name),
    location: locationOf(name, DEFAULT_REGIONAL_LOCATION),
    project: projectOf(name) || project,
    displayName: parsed.text,
    inspectConfig: policy.inspectConfig,
    rules: policy.rules ?? [],
    defaultAction: policy.defaultAction,
    unsupportedFileType: policy.unsupportedFileType,
    inputTooLarge: policy.inputTooLarge,
    failedToScanSupportedFileType: policy.failedToScanSupportedFileType,
    loggingConfigs: policy.loggingConfigs ?? [],
    createTime: policy.createTime,
    updateTime: policy.updateTime,
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : dlp
        .getProjectsLocationsContentPolicies({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

export const ContentPolicyProvider = () =>
  Provider.succeed(ContentPolicy, {
    stables: ["name", "contentPolicyId", "location", "project", "createTime"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousId = olds?.contentPolicyId ?? output?.contentPolicyId;
      const idChanged =
        previousId !== undefined &&
        news.contentPolicyId !== undefined &&
        news.contentPolicyId !== previousId;
      const previousLocation = olds?.location ?? output?.location;
      const locationChanged =
        previousLocation !== undefined &&
        news.location !== undefined &&
        normalizeLocation(news.location, DEFAULT_REGIONAL_LOCATION) !==
          normalizeLocation(previousLocation, DEFAULT_REGIONAL_LOCATION);
      return replaceOnIdentity(idChanged || locationChanged);
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const contentPolicyId = yield* toResourceId(
        id,
        olds?.contentPolicyId,
        output?.contentPolicyId,
      );
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        DEFAULT_REGIONAL_LOCATION,
      );
      const name =
        output?.name ?? resourceName(env.project, location, contentPolicyId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return (yield* ownedByAlchemy(id, existing.displayName))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const items = yield* collectPages(
          dlp.listProjectsLocationsContentPolicies.pages({
            parent: locationParent(env.project, DEFAULT_REGIONAL_LOCATION),
            pageSize: 100,
          }),
          (page) => page.contentPolicies,
        ).pipe(
          Effect.catchTag("NotFound", () =>
            Effect.succeed([] as dlp.GooglePrivacyDlpV2ContentPolicy[]),
          ),
        );
        return items
          .filter((policy) => hasOwnershipMarker(policy.displayName))
          .map((policy) => toAttrs(policy, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        news.location ?? output?.location ?? DEFAULT_REGIONAL_LOCATION,
        DEFAULT_REGIONAL_LOCATION,
      );
      const contentPolicyId = yield* toResourceId(
        id,
        news.contentPolicyId,
        output?.contentPolicyId,
      );
      const name = resourceName(env.project, location, contentPolicyId);
      const ownership = yield* createInternalLabels(id);
      const displayName = encodeOwnershipLine(
        ownership,
        news.displayName,
        MAX_CONTENT_POLICY_DISPLAY_NAME_LENGTH,
      );
      const body: dlp.GooglePrivacyDlpV2ContentPolicy = {
        displayName,
        inspectConfig: news.inspectConfig,
        rules: news.rules,
        defaultAction: news.defaultAction,
        unsupportedFileType: news.unsupportedFileType,
        inputTooLarge: news.inputTooLarge,
        failedToScanSupportedFileType: news.failedToScanSupportedFileType,
        loggingConfigs: news.loggingConfigs,
      };

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* dlp
          .createProjectsLocationsContentPolicies({
            parent: locationParent(env.project, location),
            body: {
              contentPolicyId,
              contentPolicy: body,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => getByName(name)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new ContentPolicyNotResolved({ name });
      }

      const displayChanged = (current.displayName ?? "") !== displayName;
      const inspectChanged = !jsonEqual(
        current.inspectConfig,
        news.inspectConfig,
      );
      const rulesChanged = !jsonEqual(current.rules, news.rules);
      const defaultChanged = !jsonEqual(
        current.defaultAction,
        news.defaultAction,
      );
      const unsupportedChanged = !jsonEqual(
        current.unsupportedFileType,
        news.unsupportedFileType,
      );
      const tooLargeChanged = !jsonEqual(
        current.inputTooLarge,
        news.inputTooLarge,
      );
      const failedChanged = !jsonEqual(
        current.failedToScanSupportedFileType,
        news.failedToScanSupportedFileType,
      );
      const loggingChanged = !jsonEqual(
        current.loggingConfigs,
        news.loggingConfigs,
      );

      if (
        displayChanged ||
        inspectChanged ||
        rulesChanged ||
        defaultChanged ||
        unsupportedChanged ||
        tooLargeChanged ||
        failedChanged ||
        loggingChanged
      ) {
        current = yield* dlp.patchProjectsLocationsContentPolicies({
          name: current.name ?? name,
          body: {
            contentPolicy: body,
            updateMask: updateMaskOf(
              displayChanged ? "displayName" : undefined,
              inspectChanged ? "inspectConfig" : undefined,
              rulesChanged ? "rules" : undefined,
              defaultChanged ? "defaultAction" : undefined,
              unsupportedChanged ? "unsupportedFileType" : undefined,
              tooLargeChanged ? "inputTooLarge" : undefined,
              failedChanged ? "failedToScanSupportedFileType" : undefined,
              loggingChanged ? "loggingConfigs" : undefined,
            ),
          },
        });
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* dlp
        .deleteProjectsLocationsContentPolicies({ name: output.name })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
