import * as apigee from "@distilled.cloud/gcp/apigee_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { tagRecord } from "../../Tags.ts";
import { GcpEnvironment } from "../Environment.ts";
import { createInternalLabels } from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  encodeDescription,
  environmentIdOf,
  environmentNameOf,
  hasOwnershipMarker,
  lastSegment,
  listProjectEnvironments,
  missingToUndefined,
  organizationIdOf,
  ownedById,
  parseDescription,
  parseOrgEnv,
  sameList,
  sameText,
  toResourceId,
} from "./common.ts";

const MAX_NAME_LENGTH = 63;
const DEFAULT_STATE = "ENABLED";

export type SecurityActionConditionConfig = {
  /** Developer emails. Limit 1000. */
  developers?: string[];
  /** IPv4 or IPv6 ranges. Limit 100. */
  ipAddressRanges?: string[];
  /** API keys. Limit 1000. */
  apiKeys?: string[];
  /** Developer app names. Limit 1000. */
  developerApps?: string[];
  /** Exact user-agent matches. Limit 50. */
  userAgents?: string[];
  /** API product names. Limit 1000. */
  apiProducts?: string[];
  /** Access tokens. Limit 1000. */
  accessTokens?: string[];
  /** ASN numbers. */
  asns?: string[];
  /** Bot reasons (`Flooder`, `Robot Abuser`, …). */
  botReasons?: string[];
  /** ISO 3166-1 alpha-2 region codes. */
  regionCodes?: string[];
  /** HTTP methods (`GET`, `POST`, …). */
  httpMethods?: string[];
};

export type SecurityActionDeny = {
  /** HTTP response code when denying. */
  responseCode?: number;
};

export type SecurityActionFlagHeader = {
  /** Header name sent to the target. */
  name?: string;
  /** Header value sent to the target. */
  value?: string;
};

export type SecurityActionFlag = {
  /** Headers added when flagging. At least one is required. */
  headers?: SecurityActionFlagHeader[];
};

export type EnvironmentsSecurityActionProps = {
  /**
   * Apigee organization id or `organizations/{org}`. Defaults to the
   * current GCP project id. Immutable — changing it replaces the action.
   */
  organization?: string;
  /**
   * Environment id or `organizations/{org}/environments/{env}`. Immutable —
   * changing it replaces the action.
   */
  environment: string;
  /**
   * Security action id (rfc1035, 1-63 chars). If omitted, a unique name
   * is generated. Immutable — changing it replaces the action.
   */
  securityActionId?: string;
  /**
   * Human-readable description. Alchemy stamps ownership into a
   * `[alchemy …]` prefix because security actions have no labels field.
   */
  description?: string;
  /**
   * Enforcement state. Only `ENABLED` actions are enforced.
   * @default "ENABLED"
   */
  state?: apigee.GoogleCloudApigeeV1SecurityActionStateEnum | (string & {});
  /**
   * Conditions that must match. At least one field is required.
   */
  conditionConfig: SecurityActionConditionConfig;
  /**
   * Deny matching requests. Mutually exclusive with `allow` and `flag`.
   */
  deny?: SecurityActionDeny;
  /**
   * Allow matching requests through.
   */
  allow?: boolean;
  /**
   * Flag matching requests by adding headers.
   */
  flag?: SecurityActionFlag;
  /**
   * Input-only TTL (e.g. `"3600s"`).
   */
  ttl?: string;
  /**
   * Expiration timestamp.
   */
  expireTime?: string;
  /**
   * Limit enforcement to these API proxies. Omitted applies to all.
   */
  apiProxies?: string[];
};

export type EnvironmentsSecurityAction = Resource<
  "GCP.Apigee.EnvironmentsSecurityAction",
  EnvironmentsSecurityActionProps,
  {
    /** Full resource name `organizations/{org}/environments/{env}/securityActions/{id}`. */
    name: string;
    /** Security action id. */
    securityActionId: string;
    /** Apigee organization id. */
    organizationId: string;
    /** Environment id. */
    environmentId: string;
    /** User description with the Alchemy ownership prefix stripped. */
    description: string | undefined;
    /** Enforcement state. */
    state: string | undefined;
    /** Condition configuration. */
    conditionConfig: SecurityActionConditionConfig | undefined;
    /** Deny action, if set. */
    deny: SecurityActionDeny | undefined;
    /** Whether this is an allow action. */
    allow: boolean;
    /** Flag action, if set. */
    flag: SecurityActionFlag | undefined;
    /** Expiration timestamp. */
    expireTime: string | undefined;
    /** API proxies this action applies to. */
    apiProxies: string[];
    /** RFC3339 create time. */
    createTime: string | undefined;
    /** RFC3339 update time. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * An environment-level Apigee SecurityAction — allow, deny, or flag
 * requests that match a condition.
 *
 * Security actions have no labels, so Alchemy stamps ownership into
 * `description` for `list` / nuke. Name is identity; description, state,
 * conditions, and the allow/deny/flag payload update in place.
 *
 * ### Creating a Deny Action
 * **Example:** Deny a TEST-NET address
 * ```typescript
 * const action = yield* GCP.Apigee.EnvironmentsSecurityAction("BlockProbe", {
 *   environment: "eval",
 *   conditionConfig: { ipAddressRanges: ["192.0.2.1"] },
 *   deny: { responseCode: 403 },
 * });
 * ```
 *
 * @resource
 * @category Apigee
 */
export const EnvironmentsSecurityAction = Resource<EnvironmentsSecurityAction>(
  "GCP.Apigee.EnvironmentsSecurityAction",
);

export class EnvironmentsSecurityActionNotResolved extends Data.TaggedError(
  "GCP.Apigee.EnvironmentsSecurityActionNotResolved",
)<{
  name: string;
}> {}

const resourceName = (
  organizationId: string,
  environmentId: string,
  securityActionId: string,
) =>
  `${environmentNameOf(organizationId, environmentId)}/securityActions/${securityActionId}`;

const conditionOf = (
  config: apigee.GoogleCloudApigeeV1SecurityActionConditionConfig | undefined,
): SecurityActionConditionConfig | undefined => {
  if (config === undefined) return undefined;
  return {
    developers: config.developers,
    ipAddressRanges: config.ipAddressRanges,
    apiKeys: config.apiKeys,
    developerApps: config.developerApps,
    userAgents: config.userAgents,
    apiProducts: config.apiProducts,
    accessTokens: config.accessTokens,
    asns: config.asns,
    botReasons: config.botReasons,
    regionCodes: config.regionCodes,
    httpMethods: config.httpMethods,
  };
};

const toAttrs = (
  action: apigee.GoogleCloudApigeeV1SecurityAction,
  organizationId: string,
  environmentId: string,
) => {
  const raw = action.name ?? "";
  const parsed = parseOrgEnv(raw);
  const securityActionId = lastSegment(raw);
  const description = parseDescription(action.description);
  return {
    name: raw.includes("/")
      ? raw
      : resourceName(organizationId, environmentId, securityActionId || raw),
    securityActionId: securityActionId || raw,
    organizationId: parsed.organizationId || organizationId,
    environmentId: parsed.environmentId || environmentId,
    description: description.description,
    state: action.state,
    conditionConfig: conditionOf(action.conditionConfig),
    deny:
      action.deny?.responseCode !== undefined
        ? { responseCode: action.deny.responseCode }
        : action.deny
          ? {}
          : undefined,
    allow: action.allow !== undefined,
    flag:
      action.flag?.headers !== undefined
        ? {
            headers: (action.flag.headers ?? []).map((header) => ({
              name: header.name,
              value: header.value,
            })),
          }
        : undefined,
    expireTime: action.expireTime,
    apiProxies: action.apiProxies ?? [],
    createTime: action.createTime,
    updateTime: action.updateTime,
  };
};

const getByName = (name: string) =>
  missingToUndefined(
    apigee.getOrganizationsEnvironmentsSecurityActions({ name }),
  );

const toBody = (
  news: EnvironmentsSecurityActionProps,
  description: string,
  securityActionId: string,
): apigee.GoogleCloudApigeeV1SecurityAction => ({
  name: securityActionId,
  description,
  state: news.state ?? DEFAULT_STATE,
  conditionConfig: news.conditionConfig,
  deny: news.deny,
  allow: news.allow === true ? {} : undefined,
  flag: news.flag,
  ttl: news.ttl,
  expireTime: news.expireTime,
  apiProxies: news.apiProxies,
});

const jsonOf = (value: unknown) => JSON.stringify(value ?? null);

export const EnvironmentsSecurityActionProvider = () =>
  Provider.succeed(EnvironmentsSecurityAction, {
    stables: [
      "name",
      "securityActionId",
      "organizationId",
      "environmentId",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousId = olds?.securityActionId ?? output?.securityActionId;
      const previousOrg = olds?.organization ?? output?.organizationId;
      const previousEnv = olds?.environment ?? output?.environmentId;
      const idChanged =
        previousId !== undefined &&
        news.securityActionId !== undefined &&
        news.securityActionId !== previousId;
      const orgChanged =
        previousOrg !== undefined &&
        news.organization !== undefined &&
        organizationIdOf(news.organization, "") !==
          organizationIdOf(previousOrg, "");
      const envChanged =
        previousEnv !== undefined &&
        environmentIdOf(news.environment) !== environmentIdOf(previousEnv);
      if (idChanged || orgChanged || envChanged) {
        return { action: "replace" as const, deleteFirst: false };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { project } = yield* GcpEnvironment.current;
      const organizationId = organizationIdOf(
        olds?.organization ?? output?.organizationId,
        project,
      );
      const environmentId = environmentIdOf(
        olds?.environment ?? output?.environmentId ?? "",
      );
      const securityActionId = yield* toResourceId(
        id,
        olds?.securityActionId,
        output?.securityActionId,
        { maxLength: MAX_NAME_LENGTH, rfc1035: true },
      );
      const name =
        output?.name ??
        resourceName(organizationId, environmentId, securityActionId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, organizationId, environmentId);
      const { labels } = parseDescription(existing.description);
      return (yield* ownedById(id, tagRecord(labels))) ? attrs : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const environments = yield* listProjectEnvironments();
        const found: EnvironmentsSecurityAction["Attributes"][] = [];
        for (const item of environments) {
          const actions =
            yield* apigee.listOrganizationsEnvironmentsSecurityActions
              .pages({ parent: item.parent, pageSize: 100 })
              .pipe(
                Stream.flatMap((page) =>
                  Stream.fromIterable(page.securityActions ?? []),
                ),
                Stream.filter((action) =>
                  hasOwnershipMarker(action.description),
                ),
                Stream.map((action) =>
                  toAttrs(action, item.organizationId, item.environmentId),
                ),
                Stream.runCollect,
                Effect.map((chunk) => Array.from(chunk)),
                Effect.catchTag(["NotFound", "ApigeeResourceNotFound"], () =>
                  Effect.succeed(
                    [] as EnvironmentsSecurityAction["Attributes"][],
                  ),
                ),
              );
          found.push(...actions);
        }
        return found;
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { project } = yield* GcpEnvironment.current;
      const organizationId = organizationIdOf(news.organization, project);
      const environmentId = environmentIdOf(news.environment);
      const securityActionId = yield* toResourceId(
        id,
        news.securityActionId,
        output?.securityActionId,
        { maxLength: MAX_NAME_LENGTH, rfc1035: true },
      );
      const parent = environmentNameOf(organizationId, environmentId);
      const name = resourceName(
        organizationId,
        environmentId,
        securityActionId,
      );
      const ownership = yield* createInternalLabels(id);
      const desiredDescription = encodeDescription(ownership, news.description);
      const desiredState = news.state ?? DEFAULT_STATE;

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* apigee
          .createOrganizationsEnvironmentsSecurityActions({
            parent,
            securityActionId,
            body: toBody(news, desiredDescription, securityActionId),
          })
          .pipe(Effect.catchTag("Conflict", () => getByName(name)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new EnvironmentsSecurityActionNotResolved({ name });
      }

      const descriptionChanged = !sameText(
        current.description,
        desiredDescription,
      );
      const stateChanged = !sameText(current.state, desiredState);
      const conditionChanged =
        jsonOf(conditionOf(current.conditionConfig)) !==
        jsonOf(news.conditionConfig);
      const denyChanged = jsonOf(current.deny) !== jsonOf(news.deny);
      const allowChanged =
        (current.allow !== undefined) !== (news.allow === true);
      const flagChanged = jsonOf(current.flag) !== jsonOf(news.flag);
      const expireChanged = !sameText(current.expireTime, news.expireTime);
      const proxiesChanged = !sameList(current.apiProxies, news.apiProxies);

      if (
        descriptionChanged ||
        stateChanged ||
        conditionChanged ||
        denyChanged ||
        allowChanged ||
        flagChanged ||
        expireChanged ||
        proxiesChanged
      ) {
        current = yield* apigee.patchOrganizationsEnvironmentsSecurityActions({
          name,
          updateMask: [
            descriptionChanged ? "description" : undefined,
            stateChanged ? "state" : undefined,
            conditionChanged ? "condition_config" : undefined,
            denyChanged ? "deny" : undefined,
            allowChanged ? "allow" : undefined,
            flagChanged ? "flag" : undefined,
            expireChanged ? "expire_time" : undefined,
            proxiesChanged ? "api_proxies" : undefined,
          ]
            .filter((field): field is string => field !== undefined)
            .join(","),
          body: toBody(news, desiredDescription, securityActionId),
        });
      }

      return toAttrs(current, organizationId, environmentId);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* apigee
        .deleteOrganizationsEnvironmentsSecurityActions({ name: output.name })
        .pipe(
          Effect.catchTag(
            ["NotFound", "ApigeeResourceNotFound"],
            () => Effect.void,
          ),
        );
    }),
  });
