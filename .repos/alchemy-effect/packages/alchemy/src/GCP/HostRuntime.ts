import * as Effect from "effect/Effect";
import type { ResourceBinding } from "../Resource.ts";
import { packEnvValue } from "../RuntimeContext.ts";
import { Stack } from "../Stack.ts";
import {
  defaultComputeServiceAccount,
  deleteHostServiceAccount,
  ensureHostServiceAccount,
  hostServiceAccountEmail,
  hostServiceAccountId,
  syncHostIam,
  type AppliedIamGrant,
  type GcpHostBinding,
} from "./Host.ts";

/**
 * Shared deploy-time plumbing for the GCP runtime hosts (`Run.Service`,
 * `Run.Job`, `Run.WorkerPool`, `CloudFunctions.Function`): runtime
 * identity, IAM sync, container env, and the generated bootstrap entry.
 *
 * NOT exported from `index.ts`.
 */

/** Attributes every GCP host records about its runtime identity. */
export interface HostIdentityAttrs {
  /** Runtime service account email. */
  serviceAccount: string | undefined;
  /** True when Alchemy minted the per-host runtime service account. */
  managedServiceAccount: boolean;
  /**
   * IAM roles bindings granted to the runtime service account, by target
   * resource. Used to revoke grants whose binding was removed.
   */
  iamGrants: AppliedIamGrant[];
}

/** True when `serviceAccount` is the account Alchemy mints for this host. */
export const isManagedServiceAccount = (options: {
  project: string;
  hostType: string;
  resourceName: string;
  serviceAccount: string | undefined;
}) =>
  (options.serviceAccount ?? "") ===
  hostServiceAccountEmail(
    options.project,
    hostServiceAccountId(options.hostType, options.resourceName),
  );

/**
 * Resolve the runtime identity for a host and converge its IAM.
 *
 * A user-supplied account is used as-is (grants are additive). Otherwise
 * an Effect-native host, a host with IAM bindings, or a host that was
 * already on a minted account gets its own minted account; a plain
 * image-only host with no bindings keeps the project's default Compute
 * account.
 *
 * The returned `cleanup` deletes an account minted by THIS call, for a
 * create that fails before the host exists.
 */
export const resolveHostIdentity = Effect.fn(function* (options: {
  project: string;
  hostType: string;
  resourceName: string;
  userServiceAccount: string | undefined;
  effectNative: boolean;
  bindings: readonly ResourceBinding<GcpHostBinding>[];
  output: Partial<HostIdentityAttrs> | undefined;
}) {
  const hasGrants = options.bindings.some(
    (binding) => (binding.data?.iam?.length ?? 0) > 0,
  );
  const userSa =
    options.userServiceAccount !== undefined &&
    options.userServiceAccount.length > 0
      ? options.userServiceAccount
      : undefined;
  const managed =
    userSa === undefined &&
    (options.effectNative ||
      hasGrants ||
      options.output?.managedServiceAccount === true);

  let serviceAccount: string;
  let created = false;
  if (userSa !== undefined) {
    serviceAccount = userSa;
  } else if (managed) {
    const ensured = yield* ensureHostServiceAccount({
      project: options.project,
      hostType: options.hostType,
      resourceName: options.resourceName,
    });
    serviceAccount = ensured.email;
    created = ensured.created;
  } else {
    serviceAccount = yield* defaultComputeServiceAccount(options.project);
  }

  // Grants recorded against a different account (the host switched
  // identity) belong to that account; never replay them onto this one.
  const previous =
    options.output?.serviceAccount === serviceAccount
      ? options.output.iamGrants
      : undefined;
  const synced = yield* syncHostIam({
    project: options.project,
    serviceAccount,
    managed,
    bindings: options.bindings,
    previous,
  }).pipe(
    Effect.tapError(() =>
      created
        ? deleteHostServiceAccount({
            project: options.project,
            email: serviceAccount,
          }).pipe(Effect.ignore)
        : Effect.void,
    ),
  );

  return {
    serviceAccount,
    managed,
    env: synced.env,
    grants: synced.grants,
    /** Undo a service account minted by this reconcile. */
    cleanup: created
      ? deleteHostServiceAccount({
          project: options.project,
          email: serviceAccount,
          grants: synced.grants,
        }).pipe(Effect.ignore)
      : Effect.void,
  };
});

/** Release a host's runtime identity on delete. */
export const releaseHostIdentity = (output: {
  project: string;
  serviceAccount: string | undefined;
  managedServiceAccount: boolean;
  iamGrants?: readonly AppliedIamGrant[];
}) =>
  output.serviceAccount === undefined || !output.managedServiceAccount
    ? Effect.void
    : deleteHostServiceAccount({
        project: output.project,
        email: output.serviceAccount,
        grants: output.iamGrants ?? [],
      });

/**
 * Env every Effect-native container needs to rebuild its `Stack` at boot
 * (`stackFromEnv` in the bootstrap) — the GCP counterpart of the
 * `alchemyEnv` block on `AWS.ECS.Task` / `AWS.Lambda.Function`.
 */
export const alchemyRuntimeEnv = Effect.gen(function* () {
  const stack = yield* Stack;
  return {
    ALCHEMY_STACK_NAME: stack.name,
    ALCHEMY_STAGE: stack.stage,
    ALCHEMY_PHASE: "runtime",
  } as Record<string, string>;
});

export interface ContainerEnvVar {
  name?: string;
  value?: string;
  valueSource?: unknown;
}

/**
 * Merge env maps into a container's env list without mutating either.
 * Later sources win by name; an explicit entry already on the container
 * (the user's own `containers[].env`) wins over every injected value, and
 * a name never appears twice (Cloud Run rejects duplicates).
 */
export const mergeContainerEnv = <V extends ContainerEnvVar>(
  explicit: readonly V[] | undefined,
  ...injected: ReadonlyArray<Record<string, unknown> | undefined>
): V[] => {
  const byName = new Map<string, V>();
  for (const source of injected) {
    for (const [name, value] of Object.entries(source ?? {})) {
      if (value === undefined) continue;
      byName.set(name, { name, value: packEnvValue(value) } as V);
    }
  }
  for (const entry of explicit ?? []) {
    if (entry.name === undefined) continue;
    byName.set(entry.name, entry);
  }
  return [...byName.values()].sort((left, right) =>
    (left.name ?? "").localeCompare(right.name ?? ""),
  );
};

/** Volume name and mount path Cloud Run uses for Cloud SQL Unix sockets. */
export const CLOUD_SQL_VOLUME = "cloudsql";
export const CLOUD_SQL_MOUNT_PATH = "/cloudsql";

type CloudSqlTemplate = {
  volumes?: Array<{
    name?: string;
    cloudSqlInstance?: { instances?: string[] };
  }>;
  containers?: Array<{
    volumeMounts?: Array<{ name?: string; mountPath?: string }>;
  }>;
};

/**
 * Mount the Cloud SQL instances requested by bindings (`cloudSqlInstances`)
 * as the `cloudsql` volume on the first container, so each instance's
 * socket appears at `/cloudsql/{connectionName}`. Instances the user
 * already declared on a `cloudsql` volume are kept.
 */
export const mountCloudSqlInstances = <T extends CloudSqlTemplate>(
  template: T,
  bindings: readonly ResourceBinding<GcpHostBinding>[],
): T => {
  const requested = bindings.flatMap(
    (binding) => binding.data?.cloudSqlInstances ?? [],
  );
  if (requested.length === 0) return template;
  const existing = template.volumes?.find(
    (volume) => volume.name === CLOUD_SQL_VOLUME,
  );
  const instances = [
    ...new Set([
      ...(existing?.cloudSqlInstance?.instances ?? []),
      ...requested,
    ]),
  ].sort();
  const volumes = [
    ...(template.volumes ?? []).filter(
      (volume) => volume.name !== CLOUD_SQL_VOLUME,
    ),
    { name: CLOUD_SQL_VOLUME, cloudSqlInstance: { instances } },
  ];
  const containers = (template.containers ?? []).map((container, index) =>
    index === 0 &&
    !(container.volumeMounts ?? []).some(
      (mount) => mount.name === CLOUD_SQL_VOLUME,
    )
      ? {
          ...container,
          volumeMounts: [
            ...(container.volumeMounts ?? []),
            { name: CLOUD_SQL_VOLUME, mountPath: CLOUD_SQL_MOUNT_PATH },
          ],
        }
      : container,
  );
  return { ...template, volumes, containers };
};

/**
 * Generated entry for an Effect-native GCP container: imports only
 * `alchemy/Runtime/Bootstrap/<module>` plus the user's `main`. The runtime
 * flag is raised before the user's module evaluates (hence the dynamic
 * import) so module-scope code sees it.
 */
export const makeGcpBootstrap =
  (module: "CloudRun" | "CloudRunJob", handler: string) =>
  (importPath: string): string =>
    `
import { bootstrap } from "alchemy/Runtime/Bootstrap/${module}";

globalThis.__ALCHEMY_RUNTIME__ = true;
const { ${handler}: entrypoint } = await import(${JSON.stringify(importPath)});

await bootstrap(entrypoint);
`;
