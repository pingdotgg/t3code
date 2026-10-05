import * as redis from "@distilled.cloud/gcp/redis_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { waitForOperation as waitForGcpOperation } from "../Operation.ts";

const MAX_NAME_LENGTH = 63;

export type AclRule = {
  /**
   * Redis ACL username. For IAM auth this is an IAM user or service
   * account; otherwise any Redis ACL username.
   */
  username?: string;
  /**
   * Redis OSS ACL rule string (e.g. `"on ~keys:* +get"`). See
   * https://redis.io/docs/latest/operate/oss_and_stack/management/security/acl/
   */
  rule?: string;
};

export type AclPolicyProps = {
  /**
   * ACL policy id (the `{acl_policy}` segment of
   * `projects/{project}/locations/{location}/aclPolicies/{acl_policy}`).
   * If omitted, a unique name is generated from the stack, stage, and
   * logical id. Must match `^[a-z]([a-z0-9-]{0,61}[a-z0-9])?$` (1-63
   * characters). Immutable — changing it replaces the policy.
   */
  aclPolicyId?: string;
  /**
   * Region (`us-central1`, `us-east1`, …). Immutable — changing it
   * replaces the policy. `US-CENTRAL1` is accepted and normalized to
   * `us-central1`.
   * @default the stack's GCP region (`GCP.Region`, profile region, `us-central1`)
   */
  location?: string;
  /**
   * Redis ACL rules applied to clusters that attach this policy.
   */
  rules?: AclRule[];
};

export type AclPolicy = Resource<
  "GCP.Redis.AclPolicy",
  AclPolicyProps,
  {
    /** Full resource name `projects/{project}/locations/{location}/aclPolicies/{acl_policy}`. */
    name: string;
    /** ACL policy id (last path segment). */
    aclPolicyId: string;
    /** Project id. */
    project: string;
    /** Region id (`us-central1`, …). */
    location: string;
    /** ACL rules. */
    rules: AclRule[];
    /** Server-reported state (`ACTIVE`, `UPDATING`, `DELETING`, …). */
    state: string | undefined;
    /** Server etag for optimistic concurrency. */
    etag: string | undefined;
    /** Deprecated drift-resolution version string, if present. */
    version: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Memorystore for Redis Cluster ACL policy.
 *
 * ACL policies have no labels field, so Alchemy identifies a policy by
 * its id: a policy found under the generated id is adopted, one found
 * under an explicit `aclPolicyId` without state is reported as unowned.
 * `aclPolicyId` and `location` are identity — changing either replaces
 * the policy. `rules` update in place. Create is synchronous; patch and
 * delete return long-running operations.
 *
 * Attach the policy to a Redis Cluster with the cluster's `aclPolicy`
 * field. A policy cannot be deleted while it is attached to a cluster.
 *
 * ### Creating an ACL Policy
 * **Example:** Generated name
 * ```typescript
 * const policy = yield* GCP.Redis.AclPolicy("AppAcl", {
 *   rules: [{ username: "app", rule: "on ~keys:* +get" }],
 * });
 * ```
 *
 * **Example:** Explicit id, location, and rules
 * ```typescript
 * const policy = yield* GCP.Redis.AclPolicy("AppAcl", {
 *   aclPolicyId: "app-acl",
 *   location: "us-central1",
 *   rules: [
 *     { username: "app", rule: "on ~keys:* +get" },
 *     { username: "readonly", rule: "off ~* -@all" },
 *   ],
 * });
 * ```
 *
 * ### Updating Rules
 * Change props on the same logical id; the engine keeps the physical id.
 *
 * **Example:** Add a command to an existing user
 * ```typescript
 * const policy = yield* GCP.Redis.AclPolicy("AppAcl", {
 *   location: "us-central1",
 *   rules: [{ username: "app", rule: "on ~keys:* +get +set" }],
 * });
 * ```
 *
 * @resource
 * @category Redis
 */
export const AclPolicy = Resource<AclPolicy>("GCP.Redis.AclPolicy");

export class AclPolicyNotResolved extends Data.TaggedError(
  "GCP.Redis.AclPolicyNotResolved",
)<{
  name: string;
}> {}

export class AclPolicyNotReady extends Data.TaggedError(
  "GCP.Redis.AclPolicyNotReady",
)<{
  name: string;
  state: string;
}> {}

export class AclPolicyStillExists extends Data.TaggedError(
  "GCP.Redis.AclPolicyStillExists",
)<{
  name: string;
}> {}

const lastSegment = (value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

const normalizeLocation = (location: string | undefined, fallback: string) =>
  lastSegment(location ?? fallback).toLowerCase();

const rfc1035 = (name: string): string => {
  let next = name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!/^[a-z]/.test(next)) next = `a${next}`;
  next = next.slice(0, MAX_NAME_LENGTH).replace(/-+$/g, "");
  if (next.length === 0) return "aclpolicy";
  if (!/[a-z0-9]$/.test(next)) next = `${next.slice(0, MAX_NAME_LENGTH - 1)}0`;
  return next.slice(0, MAX_NAME_LENGTH);
};

const resourceName = (project: string, location: string, aclPolicyId: string) =>
  `projects/${project}/locations/${location}/aclPolicies/${aclPolicyId}`;

const parseName = (name: string, fallbackLocation: string) => {
  const parts = name.split("/").filter((part) => part.length > 0);
  const policiesAt = parts.lastIndexOf("aclPolicies");
  const locationsAt = parts.lastIndexOf("locations");
  const projectsAt = parts.lastIndexOf("projects");
  return {
    project:
      projectsAt >= 0 && parts[projectsAt + 1] ? parts[projectsAt + 1]! : "",
    location:
      locationsAt >= 0 && parts[locationsAt + 1]
        ? parts[locationsAt + 1]!
        : fallbackLocation,
    aclPolicyId:
      policiesAt >= 0 && parts[policiesAt + 1]
        ? parts[policiesAt + 1]!
        : lastSegment(name),
  };
};

const toId = (id: string, aclPolicyId: string | undefined, existing?: string) =>
  Effect.gen(function* () {
    return (
      aclPolicyId ??
      existing ??
      rfc1035(
        yield* createPhysicalName({
          id,
          maxLength: MAX_NAME_LENGTH,
          lowercase: true,
        }),
      )
    );
  });

const ruleOf = (rule: redis.AclRule | AclRule): AclRule => ({
  username: rule.username,
  rule: rule.rule,
});

const userRulesOf = (
  rules: readonly (redis.AclRule | AclRule)[] | undefined,
): AclRule[] => (rules ?? []).map(ruleOf);

const rulesKey = (rules: readonly AclRule[]) =>
  JSON.stringify(
    [...rules]
      .map((rule) => ({
        username: rule.username ?? "",
        rule: rule.rule ?? "",
      }))
      .sort(
        (left, right) =>
          left.username.localeCompare(right.username) ||
          left.rule.localeCompare(right.rule),
      ),
  );

const desiredRules = (news: AclPolicyProps): redis.AclRule[] =>
  userRulesOf(news.rules);

const toAttrs = (policy: redis.AclPolicy, project: string, region: string) => {
  const name = policy.name ?? "";
  const parsed = parseName(name, region);
  return {
    name,
    aclPolicyId: parsed.aclPolicyId,
    project: parsed.project || project,
    location: parsed.location,
    rules: userRulesOf(policy.rules),
    state: policy.state,
    etag: policy.etag,
    version: policy.version,
  };
};

const isPlaceholder = (policy: redis.AclPolicy) => {
  const name = policy.name ?? "";
  return name.endsWith("/aclPolicies/-") || name.endsWith("/aclPolicies/");
};

const getByName = (name: string) =>
  redis
    .getProjectsLocationsAclPolicies({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

/** Wait for an operation through the shared GCP waiter. */
const waitForOperation = (
  operation: redis.Operation,
  options?: { notFoundOk?: boolean },
) =>
  waitForGcpOperation(
    operation,
    (name) =>
      redis
        .getProjectsLocationsOperations({ name })
        .pipe(
          Effect.catchTag("NotFound", (error) =>
            options?.notFoundOk === true
              ? Effect.succeed<redis.Operation>({ name, done: true })
              : Effect.fail(error),
          ),
        ),
    { budget: "10 minutes" },
  ).pipe(
    // ALREADY_EXISTS (6): a concurrent create won the race. NOT_FOUND (5)
    // is success for a delete.
    Effect.catchIf(
      (error) =>
        error._tag === "GCP.OperationFailed" &&
        (error.code === 6 ||
          (options?.notFoundOk === true && error.code === 5)),
      () => Effect.void,
    ),
  );

const waitUntilExists = (name: string) =>
  getByName(name).pipe(
    Effect.flatMap((policy) =>
      policy
        ? Effect.succeed(policy)
        : Effect.fail(new AclPolicyNotResolved({ name })),
    ),
    Effect.retry({
      while: (error) => error._tag === "GCP.Redis.AclPolicyNotResolved",
      times: 8,
      schedule: Schedule.spaced("1 second"),
    }),
  );

const waitUntilActive = (name: string) =>
  getByName(name).pipe(
    Effect.filterOrFail(
      (policy): policy is redis.AclPolicy => policy !== undefined,
      () => new AclPolicyNotResolved({ name }),
    ),
    Effect.filterOrFail(
      (policy) => {
        const state = policy.state ?? "ACTIVE";
        return state === "ACTIVE" || state === "STATE_UNSPECIFIED";
      },
      (policy) =>
        new AclPolicyNotReady({
          name,
          state: policy.state ?? "STATE_UNSPECIFIED",
        }),
    ),
    Effect.retry({
      while: (error) =>
        error._tag === "GCP.Redis.AclPolicyNotReady" ||
        error._tag === "GCP.Redis.AclPolicyNotResolved",
      times: 10,
      schedule: Schedule.spaced("3 seconds"),
    }),
  );

const waitUntilGone = (name: string) =>
  getByName(name).pipe(
    Effect.flatMap((policy) =>
      policy === undefined
        ? Effect.void
        : Effect.fail(new AclPolicyStillExists({ name })),
    ),
    Effect.retry({
      while: (error) => error._tag === "GCP.Redis.AclPolicyStillExists",
      times: 10,
      schedule: Schedule.spaced("3 seconds"),
    }),
  );

export const AclPolicyProvider = () =>
  Provider.succeed(AclPolicy, {
    stables: ["name", "aclPolicyId", "project", "location"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;

      const previousId = olds?.aclPolicyId ?? output?.aclPolicyId;
      const nextId = news.aclPolicyId ?? previousId;
      const previousLocation = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const nextLocation = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const replace =
        (previousId !== undefined &&
          nextId !== undefined &&
          nextId !== previousId) ||
        previousLocation !== nextLocation;
      if (!replace) return undefined;
      return { action: "replace" as const, deleteFirst: false };
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const aclPolicyId = yield* toId(
        id,
        olds?.aclPolicyId,
        output?.aclPolicyId,
      );
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const name =
        output?.name ?? resourceName(env.project, location, aclPolicyId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project, env.region);
      // No labels: state or the generated id proves ownership.
      return output !== undefined || olds?.aclPolicyId === undefined
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const aclPolicyId = yield* toId(
        id,
        news.aclPolicyId,
        output?.aclPolicyId,
      );
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const name = resourceName(env.project, location, aclPolicyId);
      const bodyRules = desiredRules(news);

      let current = yield* getByName(output?.name ?? name);
      if (current !== undefined && (current.state ?? "") === "DELETING") {
        yield* waitUntilGone(name);
        current = undefined;
      }

      if (current === undefined) {
        const created = yield* redis
          .createProjectsLocationsAclPolicies({
            parent: `projects/${env.project}/locations/${location}`,
            aclPolicyId,
            body: { rules: bodyRules },
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        current =
          created && created.name && !isPlaceholder(created)
            ? created
            : yield* waitUntilExists(name);
      }

      if (current === undefined) {
        return yield* new AclPolicyNotResolved({ name });
      }

      const state = current.state ?? "ACTIVE";
      if (state === "UPDATING" || state === "DELETING") {
        current = yield* waitUntilActive(name);
      }

      const rulesChanged =
        rulesKey(userRulesOf(current.rules)) !==
        rulesKey(userRulesOf(news.rules));

      if (rulesChanged) {
        const patched = yield* redis
          .patchProjectsLocationsAclPolicies({
            name,
            updateMask: "rules",
            body: { name, rules: bodyRules },
          })
          .pipe(
            Effect.retry({
              while: (error) => error._tag === "Conflict",
              times: 8,
              schedule: Schedule.spaced("2 seconds"),
            }),
          );
        yield* waitForOperation(patched);
        current = yield* waitUntilActive(name);
      }

      return toAttrs(current, env.project, env.region);
    }),

    delete: Effect.fn(function* ({ output }) {
      const operation = yield* redis
        .deleteProjectsLocationsAclPolicies({
          name: output.name,
        })
        .pipe(
          Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
          Effect.retry({
            while: (error) => error._tag === "Conflict",
            times: 8,
            schedule: Schedule.spaced("2 seconds"),
          }),
        );
      if (operation !== undefined) {
        yield* waitForOperation(operation, { notFoundOk: true });
      }
      yield* waitUntilGone(output.name);
    }),
  });
