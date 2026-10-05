import * as artifactregistry from "@distilled.cloud/gcp/artifactregistry_v1";
import * as bigquery from "@distilled.cloud/gcp/bigquery_v2";
import * as bigqueryconnection from "@distilled.cloud/gcp/bigqueryconnection_v1";
import * as bigtableadmin from "@distilled.cloud/gcp/bigtableadmin_v2";
import * as binaryauthorization from "@distilled.cloud/gcp/binaryauthorization_v1";
import * as resourcemanager from "@distilled.cloud/gcp/cloudresourcemanager_v3";
import * as cloudfunctions from "@distilled.cloud/gcp/cloudfunctions_v2";
import * as kms from "@distilled.cloud/gcp/cloudkms_v1";
import * as cloudtasks from "@distilled.cloud/gcp/cloudtasks_v2";
import * as compute from "@distilled.cloud/gcp/compute_v1";
import * as containeranalysis from "@distilled.cloud/gcp/containeranalysis_v1";
import * as dataproc from "@distilled.cloud/gcp/dataproc_v1";
import * as iam from "@distilled.cloud/gcp/unstable/iam_v1";
import * as ml from "@distilled.cloud/gcp/ml_v1";
import * as privateca from "@distilled.cloud/gcp/privateca_v1";
import type { GcpOpContext } from "@distilled.cloud/gcp/Protocol";
import * as pubsub from "@distilled.cloud/gcp/pubsub_v1";
import * as run from "@distilled.cloud/gcp/run_v2";
import * as secretmanager from "@distilled.cloud/gcp/secretmanager_v1";
import * as servicedirectory from "@distilled.cloud/gcp/servicedirectory_v1";
import * as spanner from "@distilled.cloud/gcp/spanner_v1";
import * as storage from "@distilled.cloud/gcp/storage_v1";
import * as workstations from "@distilled.cloud/gcp/workstations_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

/**
 * The subset of a Google IAM `Policy` Alchemy reads and writes. Every
 * service's generated `Policy` type is structurally compatible.
 */
export interface IamPolicy {
  version?: number;
  etag?: string;
  bindings?: ReadonlyArray<IamPolicyBinding>;
  auditConfigs?: ReadonlyArray<unknown>;
}

export interface IamPolicyBinding {
  role?: string;
  members?: ReadonlyArray<string>;
  condition?: IamCondition;
}

/**
 * An IAM Condition (CEL). Alchemy uses it to narrow a project-level grant
 * to one resource on services with no per-resource IAM policy (Firestore,
 * Cloud SQL, Memorystore, …): `resource.name == "projects/p/…"`.
 */
export interface IamCondition {
  title?: string;
  expression?: string;
  description?: string;
}

/** Condition identity: two conditions are the same binding iff equal. */
const sameCondition = (
  left: IamCondition | undefined,
  right: IamCondition | undefined,
) =>
  (left === undefined && right === undefined) ||
  (left !== undefined &&
    right !== undefined &&
    left.expression === right.expression &&
    (left.title ?? "") === (right.title ?? ""));

/**
 * Resource kinds whose own IAM policy a binding can grant on. Kinds map
 * 1:1 onto a service's `getIamPolicy` / `setIamPolicy` pair, so a grant
 * reaches exactly one resource (the GCP analog of an IAM statement's
 * `Resource: [arn]`).
 */
export type GcpIamResourceKind =
  | "project"
  | "artifactregistry.repository"
  | "bigquery.dataset"
  | "bigquery.table"
  | "bigqueryconnection.connection"
  | "bigtable.instance"
  | "bigtable.table"
  | "binaryauthorization.attestor"
  | "cloudfunctions.function"
  | "cloudtasks.queue"
  | "compute.instance"
  | "containeranalysis.note"
  | "dataproc.cluster"
  | "iam.serviceAccount"
  | "kms.cryptoKey"
  | "ml.model"
  | "privateca.caPool"
  | "pubsub.schema"
  | "pubsub.subscription"
  | "pubsub.topic"
  | "run.job"
  | "run.service"
  | "run.workerPool"
  | "secretmanager.secret"
  | "servicedirectory.namespace"
  | "servicedirectory.service"
  | "spanner.database"
  | "spanner.instance"
  | "storage.bucket"
  | "workstations.workstation"
  | "workstations.workstationConfig";

/** Error from any IAM policy operation, narrowed to the fields Alchemy reads. */
type IamPolicyError = { readonly _tag: string; readonly message?: string };

interface IamPolicyTarget {
  get: Effect.Effect<IamPolicy, IamPolicyError, GcpOpContext>;
  set: (
    policy: IamPolicy,
  ) => Effect.Effect<unknown, IamPolicyError, GcpOpContext>;
}

// The generated per-service `Policy` shapes are structurally identical to
// `IamPolicy`, but each is a distinct nominal type; these adapters bridge
// the two once instead of casting at every call site.
type QueryGet = (input: {
  resource: string;
  "options.requestedPolicyVersion"?: number;
}) => Effect.Effect<any, IamPolicyError, GcpOpContext>;
type BodyGet = (input: {
  resource: string;
  body?: { options?: { requestedPolicyVersion?: number } };
}) => Effect.Effect<any, IamPolicyError, GcpOpContext>;
type Set = (input: {
  resource: string;
  body?: { policy?: any };
}) => Effect.Effect<any, IamPolicyError, GcpOpContext>;

const queryStyle =
  (get: QueryGet, set: Set) =>
  (resource: string): IamPolicyTarget => ({
    get: get({ resource, "options.requestedPolicyVersion": 3 }),
    set: (policy) => set({ resource, body: { policy } }),
  });

const bodyStyle =
  (get: BodyGet, set: Set, policyVersion = 3) =>
  (resource: string): IamPolicyTarget => ({
    get: get({
      resource,
      body: { options: { requestedPolicyVersion: policyVersion } },
    }),
    set: (policy) => set({ resource, body: { policy } }),
  });

const bucketName = (name: string) =>
  name.replace(/^projects\/_\/buckets\//, "").replace(/^buckets\//, "");

const computeInstance = (name: string): IamPolicyTarget => {
  const match = /projects\/([^/]+)\/zones\/([^/]+)\/instances\/([^/]+)/.exec(
    name,
  );
  const [, project = "", zone = "", resource = ""] = match ?? [];
  return {
    get: compute.getIamPolicyInstances({
      project,
      zone,
      resource,
      optionsRequestedPolicyVersion: 3,
    }),
    set: (policy) =>
      compute.setIamPolicyInstances({
        project,
        zone,
        resource,
        body: { policy: policy as compute.Policy },
      }),
  };
};

type DatasetAccessItem = bigquery.DatasetAccessItem;

/** BigQuery stores the three basic dataset roles under legacy names. */
const LEGACY_DATASET_ROLES: Record<string, string> = {
  READER: "roles/bigquery.dataViewer",
  WRITER: "roles/bigquery.dataEditor",
  OWNER: "roles/bigquery.dataOwner",
};
const datasetRole = (role: string) => LEGACY_DATASET_ROLES[role] ?? role;

const principalOf = (item: DatasetAccessItem): string | undefined =>
  item.iamMember ??
  (item.userByEmail
    ? `${item.userByEmail.endsWith(".gserviceaccount.com") ? "serviceAccount" : "user"}:${item.userByEmail}`
    : item.groupByEmail
      ? `group:${item.groupByEmail}`
      : item.domain
        ? `domain:${item.domain}`
        : undefined);

const accessItemOf = (role: string, member: string): DatasetAccessItem => {
  const [type, id = ""] = member.split(/:(.*)/s);
  switch (type) {
    case "serviceAccount":
    case "user":
      return { role, userByEmail: id };
    case "group":
      return { role, groupByEmail: id };
    case "domain":
      return { role, domain: id };
    default:
      return { role, iamMember: member };
  }
};

/**
 * BigQuery datasets have no `setIamPolicy`; their access list is the
 * policy. Principal entries map to bindings; view, routine, dataset,
 * special-group, and conditional entries are carried through untouched.
 */
const bigqueryDataset = (name: string): IamPolicyTarget => {
  const match = /projects\/([^/]+)\/datasets\/([^/]+)/.exec(name);
  const [, projectId = "", datasetId = ""] = match ?? [];
  const isPrincipal = (item: DatasetAccessItem) =>
    item.condition === undefined &&
    item.role !== undefined &&
    principalOf(item) !== undefined;
  const read = bigquery.getDatasets({ projectId, datasetId });
  return {
    get: read.pipe(
      Effect.map((dataset) => {
        const byRole = new Map<string, string[]>();
        for (const item of dataset.access ?? []) {
          if (!isPrincipal(item)) continue;
          const role = datasetRole(item.role!);
          const members = byRole.get(role) ?? [];
          members.push(principalOf(item)!);
          byRole.set(role, members);
        }
        return {
          etag: dataset.etag,
          bindings: [...byRole].map(([role, members]) => ({ role, members })),
        } satisfies IamPolicy;
      }),
    ),
    set: (policy) =>
      read.pipe(
        Effect.flatMap((dataset) =>
          bigquery.patchDatasets({
            projectId,
            datasetId,
            body: {
              etag: dataset.etag,
              access: [
                ...(dataset.access ?? []).filter((item) => !isPrincipal(item)),
                ...(policy.bindings ?? []).flatMap((binding) =>
                  (binding.members ?? []).map((member) =>
                    accessItemOf(binding.role ?? "", member),
                  ),
                ),
              ],
            },
          }),
        ),
      ),
  };
};

const secret = (name: string): IamPolicyTarget =>
  /\/locations\//.test(name)
    ? queryStyle(
        secretmanager.getIamPolicyProjectsLocationsSecrets,
        secretmanager.setIamPolicyProjectsLocationsSecrets,
      )(name)
    : queryStyle(
        secretmanager.getIamPolicyProjectsSecrets,
        secretmanager.setIamPolicyProjectsSecrets,
      )(name);

const TARGETS: Record<GcpIamResourceKind, (name: string) => IamPolicyTarget> = {
  project: bodyStyle(
    resourcemanager.getIamPolicyProjects,
    resourcemanager.setIamPolicyProjects,
  ),
  "artifactregistry.repository": queryStyle(
    artifactregistry.getIamPolicyProjectsLocationsRepositories,
    artifactregistry.setIamPolicyProjectsLocationsRepositories,
  ),
  "bigquery.dataset": bigqueryDataset,
  // BigQuery table policies reject requestedPolicyVersion 3.
  "bigquery.table": bodyStyle(
    bigquery.getIamPolicyTables,
    bigquery.setIamPolicyTables,
    1,
  ),
  "bigqueryconnection.connection": bodyStyle(
    bigqueryconnection.getIamPolicyProjectsLocationsConnections,
    bigqueryconnection.setIamPolicyProjectsLocationsConnections,
  ),
  "bigtable.instance": bodyStyle(
    bigtableadmin.getIamPolicyProjectsInstances,
    bigtableadmin.setIamPolicyProjectsInstances,
  ),
  "bigtable.table": bodyStyle(
    bigtableadmin.getIamPolicyProjectsInstancesTables,
    bigtableadmin.setIamPolicyProjectsInstancesTables,
  ),
  "binaryauthorization.attestor": queryStyle(
    binaryauthorization.getIamPolicyProjectsAttestors,
    binaryauthorization.setIamPolicyProjectsAttestors,
  ),
  "cloudfunctions.function": queryStyle(
    cloudfunctions.getIamPolicyProjectsLocationsFunctions,
    cloudfunctions.setIamPolicyProjectsLocationsFunctions,
  ),
  "cloudtasks.queue": bodyStyle(
    cloudtasks.getIamPolicyProjectsLocationsQueues,
    cloudtasks.setIamPolicyProjectsLocationsQueues,
  ),
  "compute.instance": computeInstance,
  "containeranalysis.note": bodyStyle(
    containeranalysis.getIamPolicyProjectsNotes,
    containeranalysis.setIamPolicyProjectsNotes,
  ),
  "dataproc.cluster": bodyStyle(
    dataproc.getIamPolicyProjectsRegionsClusters,
    dataproc.setIamPolicyProjectsRegionsClusters,
  ),
  "iam.serviceAccount": queryStyle(
    iam.getIamPolicyProjectsServiceAccounts,
    iam.setIamPolicyProjectsServiceAccounts,
  ),
  "kms.cryptoKey": queryStyle(
    kms.getIamPolicyProjectsLocationsKeyRingsCryptoKeys,
    kms.setIamPolicyProjectsLocationsKeyRingsCryptoKeys,
  ),
  "ml.model": queryStyle(
    ml.getIamPolicyProjectsModels,
    ml.setIamPolicyProjectsModels,
  ),
  "privateca.caPool": queryStyle(
    privateca.getIamPolicyProjectsLocationsCaPools,
    privateca.setIamPolicyProjectsLocationsCaPools,
  ),
  "pubsub.schema": queryStyle(
    pubsub.getIamPolicyProjectsSchemas,
    pubsub.setIamPolicyProjectsSchemas,
  ),
  "pubsub.subscription": queryStyle(
    pubsub.getIamPolicyProjectsSubscriptions,
    pubsub.setIamPolicyProjectsSubscriptions,
  ),
  "pubsub.topic": queryStyle(
    pubsub.getIamPolicyProjectsTopics,
    pubsub.setIamPolicyProjectsTopics,
  ),
  "run.job": queryStyle(
    run.getIamPolicyProjectsLocationsJobs,
    run.setIamPolicyProjectsLocationsJobs,
  ),
  "run.service": queryStyle(
    run.getIamPolicyProjectsLocationsServices,
    run.setIamPolicyProjectsLocationsServices,
  ),
  "run.workerPool": queryStyle(
    run.getIamPolicyProjectsLocationsWorkerPools,
    run.setIamPolicyProjectsLocationsWorkerPools,
  ),
  "secretmanager.secret": secret,
  "servicedirectory.namespace": bodyStyle(
    servicedirectory.getIamPolicyProjectsLocationsNamespaces,
    servicedirectory.setIamPolicyProjectsLocationsNamespaces,
  ),
  "servicedirectory.service": bodyStyle(
    servicedirectory.getIamPolicyProjectsLocationsNamespacesServices,
    servicedirectory.setIamPolicyProjectsLocationsNamespacesServices,
  ),
  "spanner.database": bodyStyle(
    spanner.getIamPolicyProjectsInstancesDatabases,
    spanner.setIamPolicyProjectsInstancesDatabases,
  ),
  "spanner.instance": bodyStyle(
    spanner.getIamPolicyProjectsInstances,
    spanner.setIamPolicyProjectsInstances,
  ),
  "storage.bucket": (name) => ({
    get: storage.getIamPolicyBuckets({
      bucket: bucketName(name),
      optionsRequestedPolicyVersion: 3,
    }),
    set: (policy) =>
      storage.setIamPolicyBuckets({
        bucket: bucketName(name),
        body: policy as storage.Policy,
      }),
  }),
  "workstations.workstation": queryStyle(
    workstations.getIamPolicyProjectsLocationsWorkstationClustersWorkstationConfigsWorkstations,
    workstations.setIamPolicyProjectsLocationsWorkstationClustersWorkstationConfigsWorkstations,
  ),
  "workstations.workstationConfig": queryStyle(
    workstations.getIamPolicyProjectsLocationsWorkstationClustersWorkstationConfigs,
    workstations.setIamPolicyProjectsLocationsWorkstationClustersWorkstationConfigs,
  ),
};

/** A single `role` → `member` edge on one resource's IAM policy. */
export interface IamMembership {
  kind: GcpIamResourceKind;
  /** Full resource name (`projects/p/topics/t`) or project id for `project`. */
  name: string;
  role: string;
  member: string;
}

const principal = (member: string) =>
  /^(serviceAccount|user|group|domain|principal|principalSet):/.test(member) ||
  member === "allUsers" ||
  member === "allAuthenticatedUsers"
    ? member
    : `serviceAccount:${member}`;

const targetName = (kind: GcpIamResourceKind, name: string) =>
  kind === "project" && !name.startsWith("projects/")
    ? `projects/${name}`
    : name;

/**
 * Rewrite `policy` so `member` holds exactly `add` roles out of `managed`
 * (roles in `managed` but not in `add` are revoked from the member).
 * Conditional bindings are never touched — only unconditional
 * role → members edges are Alchemy's to manage. Returns `undefined` when
 * the policy already matches.
 */
const rewrite = (
  policy: IamPolicy,
  member: string,
  add: ReadonlySet<string>,
  remove: ReadonlySet<string>,
  condition?: IamCondition,
): IamPolicy | undefined => {
  const bindings = (policy.bindings ?? []).map((binding) => ({
    ...binding,
    members: [...(binding.members ?? [])],
  }));
  let dirty = false;
  for (const role of add) {
    const existing = bindings.find(
      (binding) =>
        binding.role === role && sameCondition(binding.condition, condition),
    );
    if (existing === undefined) {
      bindings.push(
        condition === undefined
          ? { role, members: [member] }
          : { role, members: [member], condition },
      );
      dirty = true;
    } else if (!existing.members.includes(member)) {
      existing.members.push(member);
      dirty = true;
    }
  }
  for (const binding of bindings) {
    if (!sameCondition(binding.condition, condition)) continue;
    if (binding.role === undefined || !remove.has(binding.role)) continue;
    if (add.has(binding.role)) continue;
    const next = binding.members.filter((item) => item !== member);
    if (next.length !== binding.members.length) {
      binding.members = next;
      dirty = true;
    }
  }
  if (!dirty) return undefined;
  // Keep the version the policy was read at: conditional bindings only
  // come back (and must be written) at v3, and some resources (BigQuery
  // tables) accept nothing above v1.
  return {
    ...policy,
    // Writing a conditional binding requires policy version 3.
    ...(condition !== undefined ? { version: 3 } : {}),
    bindings: bindings.filter((binding) => binding.members.length > 0),
  };
};

/**
 * Read-modify-write one resource's IAM policy under its etag, re-reading
 * on a concurrent-write `Conflict` (Cloud Storage: `IamPolicyEtagMismatch`)
 * so parallel host deploys converge
 * instead of failing. A freshly created service account can take a few
 * seconds to become a valid policy member, surfaced as `BadRequest`.
 */
export const updateIamMembership = (options: {
  kind: GcpIamResourceKind;
  name: string;
  member: string;
  add?: Iterable<string>;
  remove?: Iterable<string>;
  /** Manage the bindings carrying exactly this condition. */
  condition?: IamCondition;
}) => {
  const target = TARGETS[options.kind](targetName(options.kind, options.name));
  const member = principal(options.member);
  const add = new Set(options.add ?? []);
  const remove = new Set(options.remove ?? []);
  const write = Effect.gen(function* () {
    const policy = yield* target.get;
    const next = rewrite(policy, member, add, remove, options.condition);
    if (next === undefined) return;
    yield* target.set(next);
  }).pipe(
    Effect.retry({
      while: (error) =>
        error._tag === "Conflict" ||
        // Cloud Storage reports a stale etag as 412, not 409.
        error._tag === "IamPolicyEtagMismatch" ||
        (error._tag === "BadRequest" &&
          /does not exist/i.test(error.message ?? "")),
      // ~60s total: long enough for a new service account to propagate.
      times: 6,
      schedule: Schedule.exponential("1 second"),
    }),
  );
  // Don't report success until GCP reads the change back: callers (and
  // the resources that depend on them) must never race a write that has
  // not landed. A lost write (read-after-write lag, a concurrent writer
  // without etag) is re-applied.
  const confirmed = target.get.pipe(
    Effect.flatMap((policy) =>
      rewrite(policy, member, add, remove, options.condition) === undefined
        ? Effect.void
        : Effect.fail(new IamPolicyNotConverged({ name: options.name })),
    ),
  );
  return write.pipe(
    Effect.andThen(confirmed),
    Effect.retry({
      while: (error) => error._tag === "GCP.IamPolicyNotConverged",
      times: 10,
      schedule: Schedule.spaced("2 seconds"),
    }),
  );
};

/** A written IAM policy did not read back with the change applied. */
export class IamPolicyNotConverged extends Data.TaggedError(
  "GCP.IamPolicyNotConverged",
)<{ name: string }> {}

/**
 * Remove `member` from every unconditional binding of `roles` on the
 * resource. A resource that is already gone has nothing to revoke.
 */
export const revokeIamMembership = (options: {
  kind: GcpIamResourceKind;
  name: string;
  member: string;
  roles: Iterable<string>;
  condition?: IamCondition;
}) =>
  updateIamMembership({
    kind: options.kind,
    name: options.name,
    member: options.member,
    remove: options.roles,
    condition: options.condition,
  }).pipe(
    Effect.catchIf(
      (error) => error._tag === "NotFound",
      () => Effect.void,
    ),
  );

/** Roles `member` currently holds unconditionally on the project. */
export const projectRolesOf = (project: string, member: string) =>
  TARGETS.project(targetName("project", project)).get.pipe(
    Effect.map((policy) => {
      const principalId = principal(member);
      return (policy.bindings ?? [])
        .filter(
          (binding) =>
            binding.condition === undefined &&
            (binding.members ?? []).includes(principalId),
        )
        .flatMap((binding) => (binding.role ? [binding.role] : []));
    }),
  );

/** True when `member` holds `role` unconditionally on the resource. */
export const hasIamMembership = (options: {
  kind: GcpIamResourceKind;
  name: string;
  member: string;
  role: string;
}) =>
  TARGETS[options.kind](targetName(options.kind, options.name)).get.pipe(
    Effect.map((policy) =>
      (policy.bindings ?? []).some(
        (binding) =>
          binding.role === options.role &&
          binding.condition === undefined &&
          (binding.members ?? []).includes(principal(options.member)),
      ),
    ),
    Effect.catchIf(
      (error) => error._tag === "NotFound",
      () => Effect.succeed(false),
    ),
  );
