import * as networksecurity from "@distilled.cloud/gcp/networksecurity_v1";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { tagRecord } from "../../Tags.ts";
import { GcpEnvironment } from "../Environment.ts";
import {
  createInternalLabels,
  diffLabels,
  hasAlchemyLabels,
  toLabels,
} from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  parseResourceName,
  projectParent,
  ResourceNotResolved,
  sameJson,
  toPhysicalId,
  userLabels,
  waitForOperation,
  waitUntilExists,
  waitUntilGone,
} from "./operations.ts";

const DEFAULT_ACTION = "ALLOW" satisfies networksecurity.AuthzPolicyActionEnum;
const DEFAULT_PROFILE =
  "REQUEST_AUTHZ" satisfies networksecurity.AuthzPolicyPolicyProfileEnum;

export type AuthzPolicyAction =
  | networksecurity.AuthzPolicyActionEnum
  | (string & {});

export type AuthzPolicyProfile =
  | networksecurity.AuthzPolicyPolicyProfileEnum
  | (string & {});

export type AuthzPolicyLoadBalancingScheme =
  | networksecurity.AuthzPolicyTargetLoadBalancingSchemeEnum
  | (string & {});

export type AuthzPolicyStringMatch = {
  exact?: string;
  prefix?: string;
  suffix?: string;
  contains?: string;
  ignoreCase?: boolean;
};

export type AuthzPolicyHeaderMatch = {
  name?: string;
  value?: AuthzPolicyStringMatch;
};

export type AuthzPolicyRequestOperation = {
  methods?: string[];
  hosts?: AuthzPolicyStringMatch[];
  paths?: AuthzPolicyStringMatch[];
  snis?: AuthzPolicyStringMatch[];
  headerSet?: { headers?: AuthzPolicyHeaderMatch[] };
  mcp?: networksecurity.AuthzPolicyAuthzRuleToRequestOperationMCP;
};

export type AuthzPolicyRuleTo = {
  operations?: AuthzPolicyRequestOperation[];
  notOperations?: AuthzPolicyRequestOperation[];
};

export type AuthzPolicyPrincipal = {
  principal?: AuthzPolicyStringMatch;
  principalSelector?: string;
};

export type AuthzPolicyIpBlock = {
  prefix?: string;
  length?: number;
};

export type AuthzPolicyRequestResource = {
  tagValueIdSet?: { ids?: string[] };
  iamServiceAccount?: AuthzPolicyStringMatch;
};

export type AuthzPolicyRequestSource = {
  principals?: AuthzPolicyPrincipal[];
  ipBlocks?: AuthzPolicyIpBlock[];
  resources?: AuthzPolicyRequestResource[];
};

export type AuthzPolicyRuleFrom = {
  sources?: AuthzPolicyRequestSource[];
  notSources?: AuthzPolicyRequestSource[];
};

export type AuthzPolicyRule = {
  from?: AuthzPolicyRuleFrom;
  to?: AuthzPolicyRuleTo;
  when?: string;
};

export type AuthzPolicyTarget = {
  /**
   * Forwarding rules, Secure Web Proxy gateways, or Agent Gateways.
   */
  resources?: string[];
  /**
   * Load balancing scheme shared by every targeted forwarding rule.
   */
  loadBalancingScheme?: AuthzPolicyLoadBalancingScheme;
};

export type AuthzPolicyCustomProvider = {
  /** Empty object enables Cloud IAP. Mutually exclusive with `authzExtension`. */
  cloudIap?: Record<string, never>;
  /** Service-extension resources (limited to 1). */
  authzExtension?: { resources?: string[] };
};

export type AuthzPolicyProps = {
  /**
   * Authz policy id. If omitted, a unique RFC1035 name is generated from
   * the stack, stage, and logical id. Immutable — changing it replaces
   * the policy.
   */
  authzPolicyId?: string;
  /**
   * Location (`us-central1`, `global`, …). Must match the targeted
   * forwarding rules. Immutable — changing it replaces the policy.
   * @default the stack's GCP region (`GCP.Region`, profile region, `us-central1`)
   */
  location?: string;
  /**
   * Action (`ALLOW`, `DENY`, `CUSTOM`). `CUSTOM` requires
   * `customProvider`.
   * @default "ALLOW"
   */
  action?: AuthzPolicyAction;
  /**
   * Resources this policy applies to. Required.
   */
  target: AuthzPolicyTarget;
  /**
   * Authorization HTTP rules. At least one rule is required for ALLOW or
   * DENY unless `networkRules` is set. Limited to 5.
   */
  httpRules?: AuthzPolicyRule[];
  /**
   * Authorization network rules. Mutually exclusive with `httpRules`.
   * Limited to 5.
   */
  networkRules?: AuthzPolicyRule[];
  /**
   * Authorization profile. Immutable — changing it replaces the policy.
   * @default "REQUEST_AUTHZ"
   */
  policyProfile?: AuthzPolicyProfile;
  /**
   * Custom authorization provider. Required when `action` is `CUSTOM`.
   */
  customProvider?: AuthzPolicyCustomProvider;
  /**
   * Human-readable description.
   */
  description?: string;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
};

export type AuthzPolicy = Resource<
  "GCP.NetworkSecurity.AuthzPolicy",
  AuthzPolicyProps,
  {
    /** Full resource name `projects/{project}/locations/{location}/authzPolicies/{authzPolicy}`. */
    name: string;
    /** Authz policy id (last path segment). */
    authzPolicyId: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** Action (`ALLOW`, `DENY`, `CUSTOM`). */
    action: string;
    /** Targeted forwarding rules / gateways. */
    target: AuthzPolicyTarget | undefined;
    /** HTTP match rules. */
    httpRules: AuthzPolicyRule[];
    /** Network match rules. */
    networkRules: AuthzPolicyRule[];
    /** Authorization profile. */
    policyProfile: string | undefined;
    /** Custom provider, if `action` is `CUSTOM`. */
    customProvider: AuthzPolicyCustomProvider | undefined;
    /** User-provided description. */
    description: string | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Network Security AuthzPolicy for Application Load Balancers, Secure
 * Web Proxy, and Agent Gateway.
 *
 * Changing `authzPolicyId`, `location`, or `policyProfile` replaces the
 * policy. Action, target, rules, custom provider, description, and
 * labels update in place. `target.resources` must reference forwarding
 * rules or gateways that share `loadBalancingScheme`.
 *
 * ### Creating an Authz Policy
 * **Example:** Allow matching HTTP paths
 * ```typescript
 * const policy = yield* GCP.NetworkSecurity.AuthzPolicy("AllowAdmin", {
 *   location: "us-central1",
 *   action: "ALLOW",
 *   target: {
 *     loadBalancingScheme: "INTERNAL_MANAGED",
 *     resources: [forwardingRule.selfLink],
 *   },
 *   httpRules: [
 *     {
 *       to: {
 *         operations: [
 *           { methods: ["GET"], paths: [{ prefix: "/admin" }] },
 *         ],
 *       },
 *     },
 *   ],
 * });
 * ```
 *
 * @resource
 * @category NetworkSecurity
 */
export const AuthzPolicy = Resource<AuthzPolicy>(
  "GCP.NetworkSecurity.AuthzPolicy",
);

const resourceName = (
  project: string,
  location: string,
  authzPolicyId: string,
) => `projects/${project}/locations/${location}/authzPolicies/${authzPolicyId}`;

const actionOf = (value: string | undefined) =>
  (value ?? DEFAULT_ACTION).toUpperCase();

const profileOf = (value: string | undefined) =>
  (value ?? DEFAULT_PROFILE).toUpperCase();

const locationOf = (value: string | undefined, fallback: string) =>
  (value ?? fallback).toLowerCase();

const toCustomProvider = (
  provider: networksecurity.AuthzPolicyCustomProvider | undefined,
): AuthzPolicyCustomProvider | undefined => {
  if (provider === undefined) return undefined;
  return {
    cloudIap: provider.cloudIap !== undefined ? {} : undefined,
    authzExtension: provider.authzExtension,
  };
};

const toAttrs = (policy: networksecurity.AuthzPolicy, project: string) => {
  const name = policy.name ?? "";
  const parsed = parseResourceName(name);
  return {
    name,
    authzPolicyId: parsed.id,
    project: parsed.parentId || project,
    location: parsed.location,
    action: policy.action ?? DEFAULT_ACTION,
    target: policy.target,
    httpRules: (policy.httpRules ?? []) as AuthzPolicyRule[],
    networkRules: (policy.networkRules ?? []) as AuthzPolicyRule[],
    policyProfile: policy.policyProfile,
    customProvider: toCustomProvider(policy.customProvider),
    description: policy.description,
    labels: userLabels(policy.labels),
    createTime: policy.createTime,
    updateTime: policy.updateTime,
  };
};

const getByName = (name: string) =>
  networksecurity
    .getProjectsLocationsAuthzPolicies({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listOwned = (project: string) =>
  networksecurity.listProjectsLocationsAuthzPolicies
    .pages({
      parent: projectParent(project, "-"),
      pageSize: 1000,
    })
    .pipe(
      Stream.flatMap((page) => Stream.fromIterable(page.authzPolicies ?? [])),
      Stream.filter((policy) =>
        Object.keys(policy.labels ?? {}).some((key) =>
          key.startsWith("alchemy-"),
        ),
      ),
      Stream.map((policy) => toAttrs(policy, project)),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.catchTag("NotFound", () => Effect.succeed([])),
    );

const toCustomProviderBody = (
  provider: AuthzPolicyCustomProvider | undefined,
): networksecurity.AuthzPolicyCustomProvider | undefined => {
  if (provider === undefined) return undefined;
  return {
    cloudIap: provider.cloudIap !== undefined ? {} : undefined,
    authzExtension: provider.authzExtension,
  };
};

export const AuthzPolicyProvider = () =>
  Provider.succeed(AuthzPolicy, {
    stables: [
      "name",
      "authzPolicyId",
      "project",
      "location",
      "policyProfile",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const previousId = olds?.authzPolicyId ?? output?.authzPolicyId;
      const nextId = news.authzPolicyId ?? previousId;
      const previousLocation = locationOf(
        olds?.location ?? output?.location,
        env.region,
      );
      const nextLocation = locationOf(
        news.location ?? olds?.location ?? output?.location,
        env.region,
      );
      const previousProfile = profileOf(
        olds?.policyProfile ?? output?.policyProfile,
      );
      const nextProfile = profileOf(
        news.policyProfile ?? olds?.policyProfile ?? output?.policyProfile,
      );
      const replace =
        (previousId !== undefined &&
          nextId !== undefined &&
          nextId !== previousId) ||
        previousLocation !== nextLocation ||
        previousProfile !== nextProfile;
      if (!replace) return undefined;
      return {
        action: "replace" as const,
        deleteFirst:
          previousLocation === nextLocation &&
          previousId !== undefined &&
          nextId === previousId,
      };
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const authzPolicyId = yield* toPhysicalId(
        id,
        olds?.authzPolicyId,
        output?.authzPolicyId,
        "authzpolicy",
      );
      const location = locationOf(
        olds?.location ?? output?.location,
        env.region,
      );
      const name =
        output?.name ?? resourceName(env.project, location, authzPolicyId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return (yield* hasAlchemyLabels(id, tagRecord(existing.labels)))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        return yield* listOwned(env.project);
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const authzPolicyId = yield* toPhysicalId(
        id,
        news.authzPolicyId,
        output?.authzPolicyId,
        "authzpolicy",
      );
      const location = locationOf(
        news.location ?? output?.location,
        env.region,
      );
      const name = resourceName(env.project, location, authzPolicyId);
      const action = actionOf(news.action);
      const policyProfile = profileOf(news.policyProfile);
      const customProvider = toCustomProviderBody(news.customProvider);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };

      let current = yield* getByName(name);

      if (current === undefined) {
        const created = yield* networksecurity
          .createProjectsLocationsAuthzPolicies({
            parent: projectParent(env.project, location),
            authzPolicyId,
            body: {
              action,
              target: news.target,
              httpRules: news.httpRules,
              networkRules: news.networkRules,
              policyProfile,
              customProvider,
              description: news.description,
              labels: desiredLabels,
            },
          })
          .pipe(
            Effect.retry({
              while: (error) => error._tag === "Conflict",
              times: 5,
              schedule: Schedule.spaced("2 seconds"),
            }),
            Effect.catchTag("Conflict", () => Effect.succeed(undefined)),
          );
        if (created !== undefined) {
          yield* waitForOperation(created);
        }
        current = yield* waitUntilExists(getByName(name), name);
      }

      if (current === undefined) {
        return yield* new ResourceNotResolved({ name });
      }

      const observedLabels = tagRecord(current.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      const labelsChanged = upsert.length > 0 || removed.length > 0;
      const descriptionChanged =
        (current.description ?? "") !== (news.description ?? "");
      const actionChanged = actionOf(current.action) !== action;
      const targetChanged = !sameJson(current.target, news.target);
      const httpChanged = !sameJson(
        current.httpRules ?? [],
        news.httpRules ?? [],
      );
      const networkChanged = !sameJson(
        current.networkRules ?? [],
        news.networkRules ?? [],
      );
      const providerChanged = !sameJson(
        toCustomProvider(current.customProvider),
        news.customProvider,
      );

      if (
        labelsChanged ||
        descriptionChanged ||
        actionChanged ||
        targetChanged ||
        httpChanged ||
        networkChanged ||
        providerChanged
      ) {
        const updateMask = [
          labelsChanged ? "labels" : undefined,
          descriptionChanged ? "description" : undefined,
          actionChanged ? "action" : undefined,
          targetChanged ? "target" : undefined,
          httpChanged ? "httpRules" : undefined,
          networkChanged ? "networkRules" : undefined,
          providerChanged ? "customProvider" : undefined,
        ].filter((field): field is string => field !== undefined);

        const operation =
          yield* networksecurity.patchProjectsLocationsAuthzPolicies({
            name: current.name ?? name,
            updateMask: updateMask.join(","),
            body: {
              name: current.name ?? name,
              labels: desiredLabels,
              description: news.description,
              action,
              target: news.target,
              httpRules: news.httpRules,
              networkRules: news.networkRules,
              customProvider,
            },
          });
        yield* waitForOperation(operation);
        current = yield* waitUntilExists(
          getByName(current.name ?? name),
          current.name ?? name,
        );
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const operation = yield* networksecurity
        .deleteProjectsLocationsAuthzPolicies({ name: output.name })
        .pipe(
          Effect.retry({
            while: (error) => error._tag === "Conflict",
            times: 8,
            schedule: Schedule.spaced("2 seconds"),
          }),
          Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
        );
      if (operation !== undefined) {
        yield* waitForOperation(operation, { notFoundOk: true });
      }
      yield* waitUntilGone(getByName(output.name), output.name);
    }),
  });
