import * as kms from "@distilled.cloud/gcp/cloudkms_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { waitForOperation as waitForGcpOperation } from "../Operation.ts";

const MAX_NAME_LENGTH = 63;

export type SingleTenantHsmAddQuorumMember = {
  /**
   * PEM-encoded RSA-2048 public key of the 2FA key for the new quorum
   * member.
   */
  twoFactorPublicKeyPem?: string;
};

export type SingleTenantHsmRemoveQuorumMember = {
  /**
   * PEM-encoded RSA-2048 public key of the 2FA key to remove.
   */
  twoFactorPublicKeyPem?: string;
};

export type SingleTenantHsmRegisterTwoFactorAuthKeys = {
  /**
   * PEM-encoded RSA-2048 public keys for M-of-N quorum auth.
   */
  twoFactorPublicKeyPems?: string[];
  /**
   * Required approver count (M). Must be `>= 2` and
   * `<= totalApproverCount - 1`.
   */
  requiredApproverCount?: number;
};

export type SingleTenantHsmInstanceProposalProps = {
  /**
   * Parent SingleTenantHsmInstance. Full name
   * `projects/{project}/locations/{location}/singleTenantHsmInstances/{instance}`
   * or the instance id (combined with `location`). Immutable — changing
   * it replaces the proposal.
   */
  singleTenantHsmInstance: string;
  /**
   * Cloud KMS location (`us-central1`, `global`, `us`, …). Used when
   * `singleTenantHsmInstance` is a bare id. Immutable — changing it
   * replaces the proposal. `US-CENTRAL1` is accepted and normalized to
   * `us-central1`.
   * @default the stack's GCP region (`GCP.Region`, profile region, `us-central1`)
   */
  location?: string;
  /**
   * Proposal id (the last path segment). If omitted, a unique name is
   * generated from the stack, stage, and logical id. Must match
   * `[a-zA-Z0-9_-]{1,63}`. Immutable — changing it replaces the
   * proposal.
   */
  proposalId?: string;
  /**
   * Time-to-live for the proposal (e.g. `"3600s"`). Input-only.
   * Proposals expire after this duration. Immutable.
   */
  ttl?: string;
  /**
   * Refresh the instance so it stays active. Mutually exclusive with
   * the other operation fields. Immutable.
   */
  refreshSingleTenantHsmInstance?: boolean;
  /**
   * Enable a DISABLED instance. Mutually exclusive with the other
   * operation fields. Immutable.
   */
  enableSingleTenantHsmInstance?: boolean;
  /**
   * Disable an ACTIVE instance. Mutually exclusive with the other
   * operation fields. Immutable.
   */
  disableSingleTenantHsmInstance?: boolean;
  /**
   * Delete the instance. Mutually exclusive with the other operation
   * fields. Immutable.
   */
  deleteSingleTenantHsmInstance?: boolean;
  /**
   * Add a quorum member. Mutually exclusive with the other operation
   * fields. Immutable.
   */
  addQuorumMember?: SingleTenantHsmAddQuorumMember;
  /**
   * Remove a quorum member. Mutually exclusive with the other
   * operation fields. Immutable.
   */
  removeQuorumMember?: SingleTenantHsmRemoveQuorumMember;
  /**
   * Register 2FA keys to finish instance setup. Required while the
   * instance is `PENDING_TWO_FACTOR_AUTH_REGISTRATION`. Mutually
   * exclusive with the other operation fields. Immutable.
   */
  registerTwoFactorAuthKeys?: SingleTenantHsmRegisterTwoFactorAuthKeys;
};

export type SingleTenantHsmInstanceProposalAttrs = {
  /** Full resource name `projects/.../proposals/{proposal}`. */
  name: string;
  /** Proposal id (last path segment). */
  proposalId: string;
  /** Parent SingleTenantHsmInstance resource name. */
  singleTenantHsmInstance: string;
  /** Location id (`us-central1`, `global`, …). */
  location: string;
  /** Project id. */
  project: string;
  /** Current proposal state. */
  state: string | undefined;
  /** RFC3339 creation timestamp. */
  createTime: string | undefined;
  /** RFC3339 expiration timestamp. */
  expireTime: string | undefined;
  /** RFC3339 deletion timestamp, if soft-deleted. */
  deleteTime: string | undefined;
  /** RFC3339 purge timestamp, if `state` is `DELETED`. */
  purgeTime: string | undefined;
  /** Failure reason, if `state` is `FAILED`. */
  failureReason: string | undefined;
  /** Whether this proposal refreshes the instance. */
  refreshSingleTenantHsmInstance: boolean;
  /** Whether this proposal enables the instance. */
  enableSingleTenantHsmInstance: boolean;
  /** Whether this proposal disables the instance. */
  disableSingleTenantHsmInstance: boolean;
  /** Whether this proposal deletes the instance. */
  deleteSingleTenantHsmInstance: boolean;
  /** Add-quorum-member payload, if any. */
  addQuorumMember: SingleTenantHsmAddQuorumMember | undefined;
  /** Remove-quorum-member payload, if any. */
  removeQuorumMember: SingleTenantHsmRemoveQuorumMember | undefined;
  /** Register-2FA payload, if any. */
  registerTwoFactorAuthKeys:
    | SingleTenantHsmRegisterTwoFactorAuthKeys
    | undefined;
};

export type SingleTenantHsmInstanceProposal = Resource<
  "GCP.KMS.SingleTenantHsmInstanceProposal",
  SingleTenantHsmInstanceProposalProps,
  SingleTenantHsmInstanceProposalAttrs,
  never,
  Providers
>;

/**
 * A Cloud KMS SingleTenantHsmInstanceProposal — a quorum-gated operation
 * on a single-tenant HSM instance (refresh, enable, disable, delete,
 * register 2FA keys, add/remove quorum members).
 *
 * Parent instance, location, id, TTL, and the chosen operation are
 * identity (changing them replaces the proposal). Cloud KMS has no
 * update API. Proposals have no labels, so `list` returns every proposal
 * under listed instances. Single-tenant HSM is entitlement-gated.
 *
 * ### Creating a Proposal
 * **Example:** Refresh an instance
 * ```typescript
 * const proposal = yield* GCP.KMS.SingleTenantHsmInstanceProposal(
 *   "Refresh",
 *   {
 *     singleTenantHsmInstance: instanceName,
 *     refreshSingleTenantHsmInstance: true,
 *   },
 * );
 * ```
 *
 * **Example:** Register 2FA keys
 * ```typescript
 * const proposal = yield* GCP.KMS.SingleTenantHsmInstanceProposal(
 *   "Register",
 *   {
 *     singleTenantHsmInstance: instanceName,
 *     registerTwoFactorAuthKeys: {
 *       twoFactorPublicKeyPems: [pemA, pemB, pemC],
 *       requiredApproverCount: 2,
 *     },
 *   },
 * );
 * ```
 *
 * @resource
 * @category KMS
 */
export const SingleTenantHsmInstanceProposal =
  Resource<SingleTenantHsmInstanceProposal>(
    "GCP.KMS.SingleTenantHsmInstanceProposal",
  );

export class SingleTenantHsmInstanceProposalNotResolved extends Data.TaggedError(
  "GCP.KMS.SingleTenantHsmInstanceProposalNotResolved",
)<{
  name: string;
}> {}

export class SingleTenantHsmInstanceProposalOperationFailed extends Data.TaggedError(
  "GCP.KMS.SingleTenantHsmInstanceProposalOperationFailed",
)<{
  operation: string;
  message: string;
}> {}

export class SingleTenantHsmInstanceProposalPending extends Data.TaggedError(
  "GCP.KMS.SingleTenantHsmInstanceProposalPending",
)<{
  name: string;
  state: string;
}> {}

const lastSegment = (value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

const normalizeLocation = (location: string | undefined, fallback: string) =>
  lastSegment(location ?? fallback).toLowerCase();

const parseName = (name: string, fallbackLocation: string) => {
  const parts = name.split("/").filter((part) => part.length > 0);
  const proposalsAt = parts.lastIndexOf("proposals");
  const instancesAt = parts.lastIndexOf("singleTenantHsmInstances");
  const locationsAt = parts.lastIndexOf("locations");
  const projectsAt = parts.lastIndexOf("projects");
  const instance =
    instancesAt >= 0 ? parts.slice(0, instancesAt + 2).join("/") : "";
  return {
    project:
      projectsAt >= 0 && parts[projectsAt + 1] ? parts[projectsAt + 1]! : "",
    location:
      locationsAt >= 0 && parts[locationsAt + 1]
        ? parts[locationsAt + 1]!
        : fallbackLocation,
    singleTenantHsmInstance: instance,
    proposalId:
      proposalsAt >= 0 && parts[proposalsAt + 1]
        ? parts[proposalsAt + 1]!
        : lastSegment(name),
  };
};

const resolveParent = (
  project: string,
  instance: string,
  location: string | undefined,
  region: string,
) => {
  if (instance.includes("/")) {
    const parsed = parseName(
      instance.includes("/proposals/") ? instance : `${instance}/proposals/_`,
      region,
    );
    return {
      parent: parsed.singleTenantHsmInstance,
      location: parsed.location,
      project: parsed.project || project,
    };
  }
  const loc = normalizeLocation(location, region);
  return {
    parent: `projects/${project}/locations/${loc}/singleTenantHsmInstances/${instance}`,
    location: loc,
    project,
  };
};

const resourceName = (parent: string, proposalId: string) =>
  `${parent}/proposals/${proposalId}`;

const toId = (id: string, proposalId: string | undefined, existing?: string) =>
  Effect.gen(function* () {
    return (
      proposalId ??
      existing ??
      (yield* createPhysicalName({
        id,
        maxLength: MAX_NAME_LENGTH,
        lowercase: true,
      }))
    );
  });

const present = (value: unknown) => value !== undefined && value !== false;

const toAttrs = (
  proposal: kms.SingleTenantHsmInstanceProposal,
  project: string,
  region: string,
): SingleTenantHsmInstanceProposalAttrs => {
  const name = proposal.name ?? "";
  const parsed = parseName(name, region);
  return {
    name,
    proposalId: parsed.proposalId,
    singleTenantHsmInstance: parsed.singleTenantHsmInstance,
    location: parsed.location,
    project: parsed.project || project,
    state: proposal.state,
    createTime: proposal.createTime,
    expireTime: proposal.expireTime,
    deleteTime: proposal.deleteTime,
    purgeTime: proposal.purgeTime,
    failureReason: proposal.failureReason,
    refreshSingleTenantHsmInstance: present(
      proposal.refreshSingleTenantHsmInstance,
    ),
    enableSingleTenantHsmInstance: present(
      proposal.enableSingleTenantHsmInstance,
    ),
    disableSingleTenantHsmInstance: present(
      proposal.disableSingleTenantHsmInstance,
    ),
    deleteSingleTenantHsmInstance: present(
      proposal.deleteSingleTenantHsmInstance,
    ),
    addQuorumMember: proposal.addQuorumMember,
    removeQuorumMember: proposal.removeQuorumMember,
    registerTwoFactorAuthKeys: proposal.registerTwoFactorAuthKeys,
  };
};

const toBody = (
  news: SingleTenantHsmInstanceProposalProps,
): kms.SingleTenantHsmInstanceProposal => ({
  ttl: news.ttl,
  refreshSingleTenantHsmInstance: news.refreshSingleTenantHsmInstance
    ? {}
    : undefined,
  enableSingleTenantHsmInstance: news.enableSingleTenantHsmInstance
    ? {}
    : undefined,
  disableSingleTenantHsmInstance: news.disableSingleTenantHsmInstance
    ? {}
    : undefined,
  deleteSingleTenantHsmInstance: news.deleteSingleTenantHsmInstance
    ? {}
    : undefined,
  addQuorumMember: news.addQuorumMember,
  removeQuorumMember: news.removeQuorumMember,
  registerTwoFactorAuthKeys: news.registerTwoFactorAuthKeys,
});

const operationKey = (props: {
  refreshSingleTenantHsmInstance?: boolean;
  enableSingleTenantHsmInstance?: boolean;
  disableSingleTenantHsmInstance?: boolean;
  deleteSingleTenantHsmInstance?: boolean;
  addQuorumMember?: SingleTenantHsmAddQuorumMember;
  removeQuorumMember?: SingleTenantHsmRemoveQuorumMember;
  registerTwoFactorAuthKeys?: SingleTenantHsmRegisterTwoFactorAuthKeys;
}) => {
  if (props.refreshSingleTenantHsmInstance) return "refresh";
  if (props.enableSingleTenantHsmInstance) return "enable";
  if (props.disableSingleTenantHsmInstance) return "disable";
  if (props.deleteSingleTenantHsmInstance) return "delete";
  if (props.addQuorumMember !== undefined) {
    return `add:${props.addQuorumMember.twoFactorPublicKeyPem ?? ""}`;
  }
  if (props.removeQuorumMember !== undefined) {
    return `remove:${props.removeQuorumMember.twoFactorPublicKeyPem ?? ""}`;
  }
  if (props.registerTwoFactorAuthKeys !== undefined) {
    const keys = (props.registerTwoFactorAuthKeys.twoFactorPublicKeyPems ?? [])
      .slice()
      .sort()
      .join(",");
    return `register:${props.registerTwoFactorAuthKeys.requiredApproverCount ?? ""}:${keys}`;
  }
  return "";
};

const getByName = (name: string) =>
  kms
    .getProjectsLocationsSingleTenantHsmInstancesProposals({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const paginate = <A, E, R>(
  fetch: (
    pageToken: string | undefined,
  ) => Effect.Effect<{ items: A[]; nextPageToken?: string }, E, R>,
) =>
  Effect.gen(function* () {
    const found: A[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < 10; page++) {
      const response = yield* fetch(pageToken);
      found.push(...response.items);
      pageToken = response.nextPageToken;
      if (pageToken === undefined || pageToken === "") break;
    }
    return found;
  });

const listInstancesAt = (parent: string) =>
  paginate((pageToken) =>
    kms
      .listProjectsLocationsSingleTenantHsmInstances({
        parent,
        pageSize: 1000,
        pageToken,
      })
      .pipe(
        Effect.map((response) => ({
          items: response.singleTenantHsmInstances ?? [],
          nextPageToken: response.nextPageToken,
        })),
        Effect.catchTag("NotFound", () =>
          Effect.succeed({
            items: [] as kms.SingleTenantHsmInstance[],
            nextPageToken: undefined,
          }),
        ),
      ),
  );

const listProposalsInInstance = (parent: string) =>
  paginate((pageToken) =>
    kms
      .listProjectsLocationsSingleTenantHsmInstancesProposals({
        parent,
        pageSize: 1000,
        pageToken,
      })
      .pipe(
        Effect.map((response) => ({
          items: response.singleTenantHsmInstanceProposals ?? [],
          nextPageToken: response.nextPageToken,
        })),
        Effect.catchTag("NotFound", () =>
          Effect.succeed({
            items: [] as kms.SingleTenantHsmInstanceProposal[],
            nextPageToken: undefined,
          }),
        ),
      ),
  );

const listProposalsAt = (locationParent: string) =>
  Effect.gen(function* () {
    const instances = yield* listInstancesAt(locationParent);
    const pages = yield* Effect.forEach(
      instances,
      (instance) =>
        instance.name
          ? listProposalsInInstance(instance.name)
          : Effect.succeed([] as kms.SingleTenantHsmInstanceProposal[]),
      { concurrency: 4 },
    );
    return pages.flat();
  });

const waitOperation = (operation: kms.Operation) =>
  waitForGcpOperation(
    operation,
    (name) => kms.getProjectsLocationsOperations({ name }),
    { budget: "10 minutes" },
  ).pipe(
    // Re-read the finished operation for its typed response.
    Effect.flatMap(() =>
      operation.name === undefined
        ? Effect.succeed(operation)
        : kms.getProjectsLocationsOperations({ name: operation.name }),
    ),
  );

const waitReady = (
  name: string,
): Effect.Effect<
  kms.SingleTenantHsmInstanceProposal,
  | SingleTenantHsmInstanceProposalNotResolved
  | SingleTenantHsmInstanceProposalPending
  | kms.GetProjectsLocationsSingleTenantHsmInstancesProposalsError,
  kms.GcpOpContext
> => {
  const probe: Effect.Effect<
    kms.SingleTenantHsmInstanceProposal,
    | SingleTenantHsmInstanceProposalNotResolved
    | SingleTenantHsmInstanceProposalPending
    | kms.GetProjectsLocationsSingleTenantHsmInstancesProposalsError,
    kms.GcpOpContext
  > = getByName(name).pipe(
    Effect.flatMap(
      (
        proposal,
      ): Effect.Effect<
        kms.SingleTenantHsmInstanceProposal,
        | SingleTenantHsmInstanceProposalNotResolved
        | SingleTenantHsmInstanceProposalPending
      > => {
        if (proposal === undefined) {
          return Effect.fail(
            new SingleTenantHsmInstanceProposalNotResolved({ name }),
          );
        }
        if (proposal.state === "CREATING") {
          return Effect.fail(
            new SingleTenantHsmInstanceProposalPending({
              name,
              state: proposal.state,
            }),
          );
        }
        return Effect.succeed(proposal);
      },
    ),
  );
  return probe.pipe(
    Effect.retry({
      while: (error) =>
        error._tag === "GCP.KMS.SingleTenantHsmInstanceProposalPending",
      times: 8,
      schedule: Schedule.spaced("500 millis"),
    }),
  );
};

const nameFromOperation = (operation: kms.Operation) => {
  const response = operation.response;
  const value = response?.name;
  return typeof value === "string" && value.length > 0 ? value : undefined;
};

export const SingleTenantHsmInstanceProposalProvider = () =>
  Provider.succeed(SingleTenantHsmInstanceProposal, {
    stables: [
      "name",
      "proposalId",
      "singleTenantHsmInstance",
      "location",
      "project",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;

      const previousId = olds?.proposalId ?? output?.proposalId;
      const nextId = news.proposalId ?? previousId;
      const idChanged =
        previousId !== undefined &&
        nextId !== undefined &&
        nextId !== previousId;

      const previousParent =
        output?.singleTenantHsmInstance ??
        (olds?.singleTenantHsmInstance
          ? resolveParent(
              "",
              olds.singleTenantHsmInstance,
              olds.location,
              env.region,
            ).parent
          : undefined);
      const nextParent = resolveParent(
        output?.project ?? "",
        news.singleTenantHsmInstance,
        news.location ?? output?.location,
        env.region,
      ).parent;
      const parentChanged =
        previousParent !== undefined && previousParent !== nextParent;

      const previousOp = operationKey({
        refreshSingleTenantHsmInstance:
          olds?.refreshSingleTenantHsmInstance ??
          output?.refreshSingleTenantHsmInstance,
        enableSingleTenantHsmInstance:
          olds?.enableSingleTenantHsmInstance ??
          output?.enableSingleTenantHsmInstance,
        disableSingleTenantHsmInstance:
          olds?.disableSingleTenantHsmInstance ??
          output?.disableSingleTenantHsmInstance,
        deleteSingleTenantHsmInstance:
          olds?.deleteSingleTenantHsmInstance ??
          output?.deleteSingleTenantHsmInstance,
        addQuorumMember: olds?.addQuorumMember ?? output?.addQuorumMember,
        removeQuorumMember:
          olds?.removeQuorumMember ?? output?.removeQuorumMember,
        registerTwoFactorAuthKeys:
          olds?.registerTwoFactorAuthKeys ?? output?.registerTwoFactorAuthKeys,
      });
      const nextOp = operationKey(news);
      const operationChanged =
        previousOp.length > 0 && nextOp.length > 0 && previousOp !== nextOp;

      if (!idChanged && !parentChanged && !operationChanged) {
        return undefined;
      }
      return { action: "replace" as const, deleteFirst: false };
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const proposalId = yield* toId(id, olds?.proposalId, output?.proposalId);
      const name =
        output?.name ??
        (olds?.singleTenantHsmInstance || output?.singleTenantHsmInstance
          ? resourceName(
              resolveParent(
                env.project,
                olds?.singleTenantHsmInstance ??
                  output?.singleTenantHsmInstance ??
                  "",
                olds?.location ?? output?.location,
                env.region,
              ).parent,
              proposalId,
            )
          : undefined);
      if (name === undefined) return undefined;
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      // Proposals have no labels. Existence at the computed name is
      // ownership.
      return toAttrs(existing, env.project, env.region);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const found: SingleTenantHsmInstanceProposalAttrs[] = [];
        let pageToken: string | undefined;
        for (let page = 0; page < 10; page++) {
          const response = yield* kms.listProjectsLocations({
            name: `projects/${env.project}`,
            pageSize: 100,
            pageToken,
          });
          const parents = (response.locations ?? [])
            .map((location) => location.name)
            .filter((name): name is string => !!name);
          const batches = yield* Effect.forEach(
            parents,
            (parent) => listProposalsAt(parent),
            { concurrency: 4 },
          );
          for (const proposals of batches) {
            for (const proposal of proposals) {
              found.push(toAttrs(proposal, env.project, env.region));
            }
          }
          pageToken = response.nextPageToken;
          if (pageToken === undefined || pageToken === "") break;
        }
        return found;
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const proposalId = yield* toId(id, news.proposalId, output?.proposalId);
      const parent = resolveParent(
        env.project,
        news.singleTenantHsmInstance,
        news.location ?? output?.location,
        env.region,
      );
      const name = resourceName(parent.parent, proposalId);

      let current = yield* getByName(name);

      if (current === undefined) {
        const created = yield* kms
          .createProjectsLocationsSingleTenantHsmInstancesProposals({
            parent: parent.parent,
            singleTenantHsmInstanceProposalId: proposalId,
            body: toBody(news),
          })
          .pipe(
            Effect.flatMap((operation) =>
              waitOperation(operation).pipe(
                Effect.map((done) => nameFromOperation(done) ?? name),
              ),
            ),
            Effect.flatMap((resolved) => getByName(resolved)),
            Effect.catchTag("Conflict", () => getByName(name)),
          );
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new SingleTenantHsmInstanceProposalNotResolved({
          name,
        });
      }

      if (current.state === "CREATING") {
        current = yield* waitReady(current.name ?? name);
      }

      return toAttrs(current, env.project, env.region);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* kms
        .deleteProjectsLocationsSingleTenantHsmInstancesProposals({
          name: output.name,
        })
        .pipe(
          Effect.catchTag("NotFound", () => Effect.void),
          Effect.catchTag("BadRequest", () => Effect.void),
          Effect.catchTag("Conflict", () => Effect.void),
        );
    }),
  });
