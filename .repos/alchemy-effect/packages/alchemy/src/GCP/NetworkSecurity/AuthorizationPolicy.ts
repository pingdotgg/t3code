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
  normalizeLocation,
  projectParent,
  parseResourceName,
  ResourceNotResolved,
  sameJson,
  toPhysicalId,
  userLabels,
  waitForOperation,
  waitUntilExists,
  waitUntilGone,
} from "./operations.ts";

const DEFAULT_ACTION =
  "ALLOW" satisfies networksecurity.AuthorizationPolicyActionEnum;

export type AuthorizationPolicyAction =
  | networksecurity.AuthorizationPolicyActionEnum
  | (string & {});

export type AuthorizationPolicySource = {
  /** Peer identities to match (exact, prefix, suffix, or `*`). */
  principals?: string[];
  /** Source IP CIDR ranges. */
  ipBlocks?: string[];
};

export type AuthorizationPolicyHttpHeaderMatch = {
  /** Regular expression matched against the header value. */
  regexMatch?: string;
  /** HTTP header name (`:authority`, `:method`, `Host`, …). */
  headerName?: string;
};

export type AuthorizationPolicyDestination = {
  /** Host names matched against the `:authority` header. */
  hosts?: string[];
  /** Destination ports. */
  ports?: number[];
  /** HTTP methods. Must be omitted for gRPC. */
  methods?: string[];
  /** Optional HTTP header match. */
  httpHeaderMatch?: AuthorizationPolicyHttpHeaderMatch;
};

export type AuthorizationPolicyRule = {
  /** Source matchers. All sources must match. */
  sources?: AuthorizationPolicySource[];
  /** Destination matchers. All destinations must match. */
  destinations?: AuthorizationPolicyDestination[];
};

export type AuthorizationPolicyProps = {
  /**
   * Authorization policy id. If omitted, a unique RFC1035 name is
   * generated from the stack, stage, and logical id. Immutable —
   * changing it replaces the policy.
   */
  authorizationPolicyId?: string;
  /**
   * Location (`global`, `us-central1`, …). Immutable — changing it
   * replaces the policy.
   * @default "global"
   */
  location?: string;
  /**
   * Action taken when a rule matches.
   * @default "ALLOW"
   */
  action?: AuthorizationPolicyAction;
  /**
   * Match rules. At least one rule must match for `action` to apply. An
   * empty list applies `action` to every request.
   */
  rules?: AuthorizationPolicyRule[];
  /**
   * Human-readable description.
   */
  description?: string;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
};

export type AuthorizationPolicy = Resource<
  "GCP.NetworkSecurity.AuthorizationPolicy",
  AuthorizationPolicyProps,
  {
    /** Full resource name `projects/{project}/locations/{location}/authorizationPolicies/{authorizationPolicy}`. */
    name: string;
    /** Authorization policy id (last path segment). */
    authorizationPolicyId: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** Action (`ALLOW` or `DENY`). */
    action: string;
    /** Match rules. */
    rules: AuthorizationPolicyRule[];
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
 * A Network Security authorization policy for Traffic Director /
 * endpoint-config selectors.
 *
 * Changing `authorizationPolicyId` or `location` replaces the policy.
 * Action, rules, description, and labels update in place. Attach the
 * policy to a target HTTPS proxy or endpoint config selector to enforce
 * it.
 *
 * ### Creating an Authorization Policy
 * **Example:** Allow all
 * ```typescript
 * const policy = yield* GCP.NetworkSecurity.AuthorizationPolicy("Allow", {
 *   action: "ALLOW",
 * });
 * ```
 *
 * **Example:** Allow specific hosts
 * ```typescript
 * const policy = yield* GCP.NetworkSecurity.AuthorizationPolicy("Allow", {
 *   action: "ALLOW",
 *   rules: [
 *     {
 *       destinations: [{ hosts: ["api.example.com"], ports: [443] }],
 *     },
 *   ],
 *   labels: { env: "prod" },
 * });
 * ```
 *
 * @resource
 * @category NetworkSecurity
 */
export const AuthorizationPolicy = Resource<AuthorizationPolicy>(
  "GCP.NetworkSecurity.AuthorizationPolicy",
);

const resourceName = (
  project: string,
  location: string,
  authorizationPolicyId: string,
) =>
  `projects/${project}/locations/${location}/authorizationPolicies/${authorizationPolicyId}`;

const actionOf = (value: string | undefined) =>
  (value ?? DEFAULT_ACTION).toUpperCase();

const toRules = (
  rules: networksecurity.RuleList | AuthorizationPolicyRule[] | undefined,
): AuthorizationPolicyRule[] =>
  (rules ?? []).map((rule) => ({
    sources: rule.sources,
    destinations: rule.destinations,
  }));

const toAttrs = (
  policy: networksecurity.AuthorizationPolicy,
  project: string,
) => {
  const name = policy.name ?? "";
  const parsed = parseResourceName(name);
  return {
    name,
    authorizationPolicyId: parsed.id,
    project: parsed.parentId || project,
    location: parsed.location,
    action: policy.action ?? DEFAULT_ACTION,
    rules: toRules(policy.rules),
    description: policy.description,
    labels: userLabels(policy.labels),
    createTime: policy.createTime,
    updateTime: policy.updateTime,
  };
};

const getByName = (name: string) =>
  networksecurity
    .getProjectsLocationsAuthorizationPolicies({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listOwned = (project: string) =>
  networksecurity.listProjectsLocationsAuthorizationPolicies
    .pages({
      parent: projectParent(project, "-"),
      pageSize: 1000,
    })
    .pipe(
      Stream.flatMap((page) =>
        Stream.fromIterable(page.authorizationPolicies ?? []),
      ),
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

export const AuthorizationPolicyProvider = () =>
  Provider.succeed(AuthorizationPolicy, {
    stables: [
      "name",
      "authorizationPolicyId",
      "project",
      "location",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousId =
        olds?.authorizationPolicyId ?? output?.authorizationPolicyId;
      const nextId = news.authorizationPolicyId ?? previousId;
      const previousLocation = normalizeLocation(
        olds?.location ?? output?.location,
      );
      const nextLocation = normalizeLocation(
        news.location ?? olds?.location ?? output?.location,
      );
      const replace =
        (previousId !== undefined &&
          nextId !== undefined &&
          nextId !== previousId) ||
        previousLocation !== nextLocation;
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
      const authorizationPolicyId = yield* toPhysicalId(
        id,
        olds?.authorizationPolicyId,
        output?.authorizationPolicyId,
        "authzpolicy",
      );
      const location = normalizeLocation(olds?.location ?? output?.location);
      const name =
        output?.name ??
        resourceName(env.project, location, authorizationPolicyId);
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
      const authorizationPolicyId = yield* toPhysicalId(
        id,
        news.authorizationPolicyId,
        output?.authorizationPolicyId,
        "authzpolicy",
      );
      const location = normalizeLocation(news.location ?? output?.location);
      const name = resourceName(env.project, location, authorizationPolicyId);
      const action = actionOf(news.action);
      const rules = news.rules;
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };

      let current = yield* getByName(name);

      if (current === undefined) {
        const created = yield* networksecurity
          .createProjectsLocationsAuthorizationPolicies({
            parent: projectParent(env.project, location),
            authorizationPolicyId,
            body: {
              action,
              rules,
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
      const rulesChanged = !sameJson(toRules(current.rules), toRules(rules));

      if (
        labelsChanged ||
        descriptionChanged ||
        actionChanged ||
        rulesChanged
      ) {
        const updateMask = [
          labelsChanged ? "labels" : undefined,
          descriptionChanged ? "description" : undefined,
          actionChanged ? "action" : undefined,
          rulesChanged ? "rules" : undefined,
        ].filter((field): field is string => field !== undefined);

        const operation =
          yield* networksecurity.patchProjectsLocationsAuthorizationPolicies({
            name: current.name ?? name,
            updateMask: updateMask.join(","),
            body: {
              name: current.name ?? name,
              labels: desiredLabels,
              description: news.description,
              action,
              rules,
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
        .deleteProjectsLocationsAuthorizationPolicies({ name: output.name })
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
