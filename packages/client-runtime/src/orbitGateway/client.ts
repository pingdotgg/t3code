// @effect-diagnostics globalTimers:off - The Gateway client runs in the app, outside an Effect runtime.
import * as Schema from "effect/Schema";

/**
 * The Conn layer of the Orbit Gateway (`/api/v1/conn`, see Orbit's docs/reference/conn.md).
 *
 * The Gateway knows the caller by its WireGuard address, so a request carries no credentials. Each
 * app supplies the transport: the desktop main process (Electron `net.fetch`, which trusts the
 * Orbit root CA from the keychain and sends no `Origin`), or `fetch` on the phone.
 */

export const DEFAULT_ORBIT_GATEWAY_URL = "https://gateway.orbit";

export interface OrbitGatewayRequest {
  readonly method: "GET" | "POST" | "PUT" | "PATCH";
  /** A path below `/api/v1/conn`, such as `/me`. */
  readonly path: string;
  readonly body?: unknown;
  /**
   * Query parameters, kept apart from `path` so each transport can encode them and the desktop
   * main process can check them against its allow-list.
   */
  readonly query?: Readonly<Record<string, string>>;
  /** Overrides the transport's default limit for a call the Gateway answers slowly. */
  readonly timeoutMs?: number;
  /** Sent as `Idempotency-Key`: the same key and input return the same Operation. */
  readonly idempotencyKey?: string;
  /**
   * Conn: `path` is below `/api/v1`, not `/api/v1/conn`. The desktop permits only exact lifecycle
   * and private Tasks realtime calls.
   */
  readonly root?: true;
}

export interface OrbitGatewayResponse {
  readonly status: number;
  readonly body: string;
}

/** The request's path with its query encoded, for transports that build one URL. */
export function orbitGatewayPathWithQuery(
  request: Pick<OrbitGatewayRequest, "path" | "query">,
): string {
  const entries = Object.entries(request.query ?? {});
  return entries.length === 0 ? request.path : `${request.path}?${new URLSearchParams(entries)}`;
}

export type OrbitGatewayTransport = (request: OrbitGatewayRequest) => Promise<OrbitGatewayResponse>;

/** A failed Gateway call. `code` is the Gateway's error code, or `gateway.unreachable`/`gateway.response_invalid`. */
export class OrbitGatewayError extends Schema.TaggedError<OrbitGatewayError>()(
  "OrbitGatewayError",
  {
    code: Schema.String,
    message: Schema.String,
    status: Schema.Number,
    details: Schema.Record(Schema.String, Schema.Unknown),
  },
) {}

export interface OrbitGatewayProfile {
  readonly id: number;
  readonly name: string;
  readonly settingsVersion: number;
  readonly updatedAt: string;
}

export interface OrbitGatewayNode {
  readonly id: number;
  readonly name: string;
  readonly wireguardIp: string;
  readonly profile: OrbitGatewayProfile | null;
  /**
   * The private Reverb channel that announces this Node's profile changes, or null while it is
   * unbound or the Gateway predates profile events. Its key rotates within 15 minutes.
   */
  readonly profileChannel?: string | null;
}

/** A workspace as the profile settings store it: the same shape as the desktop's workspace store. */
export interface OrbitGatewayWorkspace {
  readonly id: string;
  readonly name: string;
  readonly color: string;
  readonly icon: string | null;
  readonly image?: string | null;
  readonly projectRefs?: readonly string[];
  readonly projectKeys?: readonly string[];
}

/** Who changed one section of a profile, and when. */
export interface OrbitGatewaySectionMeta {
  readonly version: number;
  readonly updatedAt: string | null;
  readonly updatedBy: string | null;
}

export interface OrbitGatewaySettings {
  readonly profileId: number;
  readonly version: number;
  readonly workspaces: readonly OrbitGatewayWorkspace[];
  readonly updatedAt: string;
  /** The whole settings document as sent, so sections this client does not know stay readable. */
  readonly document: Readonly<Record<string, unknown>>;
  /**
   * Version, time and author of each section the Gateway has written, or null from a Gateway
   * that predates sections (it also cannot PATCH).
   */
  readonly sections: Readonly<Record<string, OrbitGatewaySectionMeta>> | null;
}

/** One section in a PATCH: the version this device last read (0 = never written) and the new value (null clears it). */
export interface OrbitGatewaySectionPatch {
  readonly version: number;
  readonly value: Readonly<Record<string, unknown>> | null;
}

export interface OrbitGatewayEnvironment {
  readonly environmentId: string;
  readonly label: string;
  readonly url: string;
  readonly serverVersion: string | null;
  readonly registeredBy: string | null;
  /** When the server last registered. A refused pairing waits for the next registration. */
  readonly registeredAt: string | null;
  readonly status: "registered" | "session_expired";
  /** The container Instance whose T3 server this is, or null for a server that registered itself. */
  readonly instanceId: number | null;
  /** The Instance container's power state; `stopped` means the Instance is asleep. */
  readonly powerState: "running" | "stopped" | null;
  /** Conn: the clone's Orbit Project, Instance, Node and URL; null on host servers or when not sent. */
  readonly projectId: number | null;
  readonly projectName: string | null;
  readonly projectSlug: string | null;
  readonly instanceName: string | null;
  readonly nodeName: string | null;
  readonly instanceUrl: string | null;
}

/** A Project a thread can start in: its default Instance runs in a container on `nodeName`. */
export interface OrbitGatewayProject {
  readonly id: number;
  readonly slug: string;
  readonly name: string;
  readonly nodeId: number;
  readonly nodeName: string;
  /** The Project's domain after the Instance name, as listed; the phone shows the address with it. */
  readonly instanceDomainSuffix?: string | null;
}

/** One start check of a Project, in Orbit's order. `code` and `message` come only with a fail. */
export interface OrbitGatewayProjectCheck {
  readonly key: string;
  /** Orbit's display text for the check, when sent. */
  readonly label: string | null;
  readonly status: "pass" | "fail" | "not_checked";
  readonly code: string | null;
  readonly message: string | null;
}

/**
 * A row of `GET /conn/projects`. Orbit is adding Projects in which threads cannot start yet; a
 * row without `cloneable` is one that can, as every row was before. Node fields are null for a
 * caller without access to the Node.
 */
export interface OrbitGatewayProjectListing {
  readonly id: number;
  readonly slug: string;
  readonly name: string;
  readonly nodeId: number | null;
  readonly nodeName: string | null;
  readonly instanceDomainSuffix: string | null;
  readonly cloneable: boolean;
  readonly cloneableReason: string | null;
  /** Null when the Gateway sent no checks. */
  readonly checks: readonly OrbitGatewayProjectCheck[] | null;
}

/** The listing as a Project a thread can start in, or null when it cannot (yet). */
export function startableOrbitProject(
  listing: OrbitGatewayProjectListing,
): OrbitGatewayProject | null {
  if (!listing.cloneable || listing.nodeId === null || listing.nodeName === null) return null;
  return {
    id: listing.id,
    slug: listing.slug,
    name: listing.name,
    nodeId: listing.nodeId,
    nodeName: listing.nodeName,
    instanceDomainSuffix: listing.instanceDomainSuffix,
  };
}

/**
 * Why a name is not available: `taken`, `invalid` (Orbit's name rule), `default`, or
 * `domain_invalid` (`<name>.<project domain>` breaks Orbit's address limits; Orbit decides them).
 */
export type OrbitGatewayInstanceNameReason = "taken" | "invalid" | "default" | "domain_invalid";

/**
 * The answer of `GET /conn/projects/{project}/instances/check`. Names are unique per Project
 * across the fleet, and a create pending elsewhere holds its name. `domain` may be null.
 */
export interface OrbitGatewayInstanceNameCheck {
  readonly name: string;
  readonly available: boolean;
  /** Null when available, or when Orbit sent a reason this client does not know. */
  readonly reason: OrbitGatewayInstanceNameReason | null;
  readonly domain: string | null;
}

/** A pull request on a branch: the open one, newest first, when there are several. */
export interface OrbitGatewayBranchPullRequest {
  readonly number: number;
  readonly title: string | null;
  readonly url: string | null;
}

/** One branch of a Project's repository, as `GET /conn/projects/{id}/branches` lists it. */
export interface OrbitGatewayBranch {
  readonly name: string;
  readonly default: boolean;
  readonly pullRequest: OrbitGatewayBranchPullRequest | null;
  /** The Instance of the Project that works on this branch (lowest id when several), or null. */
  readonly instance: { readonly id: number; readonly name: string } | null;
}

export interface OrbitGatewayBranches {
  /** At most 100 matches, the default branch first, then by name. */
  readonly branches: readonly OrbitGatewayBranch[];
  /** No PR data for the repository (GitHub failed or is not connected): show no PR badges. */
  readonly pullRequestsUnavailable: boolean;
}

/**
 * The branch a new Instance works on. Without one Orbit clones as before. `new`: the Instance gets
 * its own branch, named after it, cut from `from`. `existing`: it checks out and pushes to `name`.
 */
export type OrbitGatewayBranchSelection =
  | { readonly mode: "new"; readonly from: string }
  | { readonly mode: "existing"; readonly name: string };

/** Create refusals for a branch, all at admission (nothing created). */
export const ORBIT_BRANCH_IN_USE = "branch.in_use";
export const ORBIT_BRANCH_NOT_FOUND = "branch.not_found";
/** A new branch named after the Instance already exists on the remote. */
export const ORBIT_BRANCH_EXISTS = "branch.exists";
export const ORBIT_SOURCE_HEAD_UNAVAILABLE = "source.head_unavailable";
/** The same name was created before with another branch selection. */
export const ORBIT_PLACEMENT_CONFLICT = "instance.placement_conflict";
/** The Instance's address `<name>.<project domain>` breaks Orbit's limits; nothing created. */
export const ORBIT_ROUTE_DOMAIN_INVALID = "route.domain_invalid";
/** Failed create steps, after the Instance exists. */
export const ORBIT_CREATE_CLONE_FAILED = "instance.create_clone_failed";
export const ORBIT_CREATE_WORKSPACE_FAILED = "instance.create_workspace_failed";
/**
 * A Project process of the new Instance did not stay up. Older Gateways keep the broken process
 * on the kept Instance, so a Retry fails the same way; newer ones retry with the Project's current
 * process definitions and say so with `ORBIT_RECOVERY_REQUIRES_PROCESS_DEFINITION`.
 */
export const ORBIT_CONTAINER_PROCESS_INACTIVE = "instance.container_process_inactive";
/** `result.recovery.requires` of a failed create that a Retry fixes after the Project's process changes. */
export const ORBIT_RECOVERY_REQUIRES_PROCESS_DEFINITION = "project_process_definition";

export interface OrbitGatewayProjectsOptions {
  /**
   * Also list the Projects in which threads cannot start yet, with their checks
   * (`include_unavailable=1`). Without it Orbit lists only the ones that can.
   */
  readonly includeUnavailable?: boolean;
}

/** The fields of an Orbit Operation that Conn follows. */
export interface OrbitGatewayOperation {
  readonly id: number;
  readonly kind: string;
  readonly status:
    | "queued"
    | "running"
    | "waiting"
    | "succeeded"
    | "failed"
    | "cancelled"
    | "interrupted";
  readonly targetId: number;
  readonly errorCode: string | null;
  /** Seconds to wait before the next read, or null once the Operation ended. */
  readonly pollAfterSeconds: number | null;
  /**
   * Step progress. Present only when the Gateway sends it; an Operation without it parses as
   * before, and a malformed step is dropped.
   */
  readonly steps?: readonly OrbitGatewayOperationStep[];
  readonly currentStep?: string | null;
  readonly currentStepStartedAt?: string | null;
  readonly failedStep?: string | null;
  readonly error?: OrbitGatewayOperationError | null;
  readonly result?: Readonly<Record<string, unknown>> | null;
  /** `result.process_failure.unit`: the Project process that did not stay up, when Orbit names it. */
  readonly processFailureUnit?: string | null;
  /** `result.recovery.retry.requires`: what must change before a Retry of a retained create works. */
  readonly recoveryRequires?: string | null;
  /** `result.recovery.retry` is present: Orbit takes a Retry of this Operation's target. */
  readonly recoveryRetryable?: boolean;
  /**
   * `result.completion_operation_id` of a create: the `instance.complete` Operation that sets up
   * the rest after the thread is usable. Absent on older Gateways.
   */
  readonly completionOperationId?: number | null;
  /** `input.route_id` of a create: null when the Project has no Route; absent when not sent. */
  readonly routeId?: number | null;
  /** `result.failed_step`: the phase of a failed completion, such as `workspace` or `route`. */
  readonly resultFailedStep?: string | null;
  /** A cancel was asked, for example by a removal. */
  readonly cancelRequested?: boolean;
  /** True while Orbit names a place in its task queue (`capacity_wait`); absent when not sent. */
  readonly capacityWait?: boolean;
}

export interface OrbitGatewayOperationError {
  readonly code: string | null;
  readonly message: string | null;
  /** Orbit's own detail line for the failure, such as the tool's stderr; often absent. */
  readonly detail: string | null;
}

/** One step of an Operation. `status` is the Gateway's own word; unknown values pass through. */
export interface OrbitGatewayOperationStep {
  readonly name: string;
  /** Orbit's stable group of a create step, such as `container`; absent on older Gateways. */
  readonly group?: string | null;
  readonly job: string | null;
  readonly status: string;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
}

export const OPERATION_TERMINAL_STATUSES: ReadonlySet<OrbitGatewayOperation["status"]> = new Set([
  "succeeded",
  "failed",
  "cancelled",
  "interrupted",
]);

export interface OrbitGatewayPairing {
  readonly environmentId: string;
  readonly pairingUrl: string;
  readonly expiresAt: string;
}

export interface OrbitGatewayClient {
  readonly me: () => Promise<OrbitGatewayNode>;
  readonly profiles: () => Promise<readonly OrbitGatewayProfile[]>;
  readonly createProfile: (name: string) => Promise<OrbitGatewayProfile>;
  readonly bindProfile: (profileId: number) => Promise<OrbitGatewayNode>;
  readonly settings: (profileId: number) => Promise<OrbitGatewaySettings>;
  /** Replaces the workspaces. A stale `version` fails with `conn.settings_version_conflict`. */
  readonly replaceWorkspaces: (
    profileId: number,
    version: number,
    workspaces: readonly OrbitGatewayWorkspace[],
  ) => Promise<OrbitGatewaySettings>;
  /**
   * Writes the given sections in one all-or-nothing request. A stale section version fails the
   * whole request with `conn.settings_version_conflict`; an older Gateway answers 404 or 405.
   */
  readonly patchSections: (
    profileId: number,
    sections: Readonly<Record<string, OrbitGatewaySectionPatch>>,
  ) => Promise<OrbitGatewaySettings>;
  readonly environments: () => Promise<readonly OrbitGatewayEnvironment[]>;
  /**
   * Conn: the Gateway's thread index of every container server this Node may see
   * (`GET /conn/threads`, unfiltered, so it never reads a server through). Use
   * `readOrbitThreadIndex`.
   */
  readonly threads: () => Promise<OrbitThreadIndex>;
  /**
   * Mints a one-time pairing link to the server for this device, following the Gateway's
   * Operation. `renew`: an automatic pairing of a saved server, which Orbit refuses with 409
   * `conn.pairing_revoked` once this Node's pairing there is revoked (older Gateways ignore it).
   */
  readonly pair: (
    environmentId: string,
    options?: OrbitGatewayPairOptions,
  ) => Promise<OrbitGatewayPairing>;
  /** The Projects this device sees; `startableOrbitProject` keeps those a thread can start in. */
  readonly projects: (
    options?: OrbitGatewayProjectsOptions,
  ) => Promise<readonly OrbitGatewayProjectListing[]>;
  /**
   * Asks Orbit whether a new Instance of the Project may take this name. A Project whose default
   * is not ready fails with 409 `instance.default_missing`, as a create would.
   */
  readonly checkInstanceName: (
    projectId: number,
    name: string,
  ) => Promise<OrbitGatewayInstanceNameCheck>;
  /**
   * Admits the clone a thread starts in; the Operation's `targetId` is the new Instance. The
   * Gateway admits it slowly, so the call has a 60 s limit; the same key returns the same Operation.
   */
  readonly createThreadInstance: (
    projectId: number,
    name: string,
    idempotencyKey: string,
    /** Sent only when given; a create without it behaves as before. */
    branch?: OrbitGatewayBranchSelection | null,
  ) => Promise<OrbitGatewayOperation>;
  /**
   * The Project's branches whose name contains `query` (ignoring case). The Gateway bounds one
   * read at 20 s, so the call waits 25 s. An unreadable source, or a query that is no valid ref
   * name, fails with 502 `source.head_unavailable`.
   */
  readonly branches: (projectId: number, query: string) => Promise<OrbitGatewayBranches>;
  /**
   * Admits a new `instance.complete` for a clone whose completion failed or was cancelled
   * (`POST /conn/instances/{id}/complete`). The same key returns the same Operation; refusals are
   * 409 `instance.complete_unavailable` and `operation.target_busy`.
   */
  readonly completeInstance: (
    instanceId: number,
    idempotencyKey: string,
  ) => Promise<OrbitGatewayOperation>;
  /** Reads an Operation this device started through the Conn layer. */
  readonly operation: (operationId: number) => Promise<OrbitGatewayOperation>;
  /** Asks Orbit to stop an Operation this device started; the stop may still be pending. */
  readonly cancelOperation: (operationId: number) => Promise<OrbitGatewayOperation>;
  /**
   * Admits a pairing with the server; the Operation's `targetId` is the pairing. Admission copies
   * a secret to Swamp, so it has the create's limit; the same key returns the same Operation.
   */
  readonly startPairing: (
    environmentId: string,
    idempotencyKey: string,
  ) => Promise<OrbitGatewayOperation>;
  /** Reads the link of a pairing whose Operation succeeded. The Gateway hands it out once. */
  readonly readPairing: (environmentId: string, pairingId: number) => Promise<OrbitGatewayPairing>;
  /**
   * Conn: asks Orbit to destroy an Instance (handle A, not live yet); the Operation's kind is
   * `instance.destroy`. Without `acknowledgeUnsaved`, Orbit refuses an Instance with unsaved work
   * or an unreadable Git state (409 `instance.unsaved_work`). Use `removeOrbitInstance`.
   */
  readonly destroyInstance: (
    instanceId: number,
    acknowledgeUnsaved: boolean,
    idempotencyKey: string,
  ) => Promise<OrbitGatewayOperation>;
  /**
   * Conn: reads one Instance's work state before a remove (`GET /conn/instances/{id}/work`).
   * Throws like every call; an older Gateway answers 404. Use `readOrbitInstanceGit`.
   */
  readonly instanceGit: (instanceId: number, timeoutMs: number) => Promise<unknown>;
  /**
   * Conn: asks Orbit to wake an asleep Instance (`POST /api/v1/instances/{id}/wake`, outside the
   * Conn layer). The answer's Operation may already have ended. Use `createOrbitInstanceWaker`.
   */
  readonly wakeInstance: (
    instanceId: number,
    idempotencyKey: string,
  ) => Promise<OrbitGatewayWakeOperation>;
  /** Conn: reads a wake's Operation (`GET /api/v1/operations/{id}`; the Conn read does not serve it). */
  readonly wakeOperation: (operationId: number) => Promise<OrbitGatewayWakeOperation>;
}

/** Conn: an `instance.wake` Operation. Its statuses include `pending`, which the Conn layer never sends. */
export interface OrbitGatewayWakeOperation {
  readonly id: number;
  readonly status: string;
  readonly errorCode: string | null;
  readonly pollAfterSeconds: number | null;
}

export const SETTINGS_VERSION_CONFLICT = "conn.settings_version_conflict";

export interface OrbitGatewayPairOptions {
  /** Sends `{"renew": true}`: a background renewal, which a revoked pairing stops. */
  readonly renew?: boolean;
}

/**
 * Orbit's answer to a renewal when this Node's newest pairing with the server is revoked. Final:
 * only an explicit Connect pairs that server again.
 */
const PAIRING_REVOKED = "conn.pairing_revoked";

/** How long `pair` follows the Gateway's Operation, and the bounds of its poll interval. */
export const OPERATION_TIMEOUT_MS = 60_000;
/** The Gateway copies secrets to Swamp before it admits a create or a pairing: 19-27 s today. */
const ADMISSION_TIMEOUT_MS = 60_000;
/** A name check is answered at once; a slow one gives way to the create's own check. */
const NAME_CHECK_TIMEOUT_MS = 5_000;
/** The Gateway bounds a branch read at 20 s (source 10 s, PR listing 10 s). */
const BRANCHES_TIMEOUT_MS = 25_000;
const MIN_POLL_MS = 500;
const MAX_POLL_MS = 15_000;

/** The wait before the next read of an Operation: the Gateway's interval, kept between 0.5 and 15 s. */
export function operationPollDelayMs(pollAfterSeconds: number | null): number {
  return Math.min(Math.max((pollAfterSeconds ?? 0) * 1000, MIN_POLL_MS), MAX_POLL_MS);
}
/** Operation statuses that are not final yet; every other status ends the Operation. */
const OPEN_OPERATION_STATUSES: ReadonlySet<string> = new Set(["queued", "running", "waiting"]);

/**
 * Pairing error codes that the Gateway calls final: T3 answered and refused. Callers must not
 * retry them on their own (Orbit docs/reference/conn.md, "Pairing Operations").
 */
const FINAL_PAIRING_ERROR_CODES: ReadonlySet<string> = new Set([
  "conn.session_rejected",
  "conn.request_refused",
  "conn.response_invalid",
  PAIRING_REVOKED,
]);

export interface OrbitGatewayClientOptions {
  /** Waits between Operation polls. Tests replace it. */
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
}

export function createOrbitGatewayClient(
  transport: OrbitGatewayTransport,
  options: OrbitGatewayClientOptions = {},
): OrbitGatewayClient {
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? Date.now;
  const call = async (request: OrbitGatewayRequest): Promise<unknown> =>
    (await callEnvelope(request)).data;
  const callEnvelope = async (request: OrbitGatewayRequest): Promise<Record<string, unknown>> => {
    let response: OrbitGatewayResponse;
    try {
      response = await transport(request);
    } catch (cause) {
      throw new OrbitGatewayError({
        code: "gateway.unreachable",
        message: `The Orbit Gateway did not answer: ${cause instanceof Error ? cause.message : String(cause)}`,
        status: 0,
        details: {},
      });
    }
    const json = parseJson(response.body);
    if (response.status < 200 || response.status >= 300) {
      const error = record(record(json)?.error);
      throw new OrbitGatewayError({
        code: typeof error?.code === "string" ? error.code : "gateway.request_failed",
        message:
          typeof error?.message === "string"
            ? error.message
            : gatewayFallbackMessage(response.status),
        status: response.status,
        details: record(error?.details) ?? {},
      });
    }
    const envelope = record(json);
    if (!envelope || !("data" in envelope)) {
      throw invalid(request.path);
    }
    return envelope;
  };

  /** Polls a Conn Operation until it ends, and returns it when it succeeded. */
  const settle = async (
    started: Record<string, unknown> | null,
    path: string,
  ): Promise<Record<string, unknown>> => {
    let operation = started;
    const deadline = now() + OPERATION_TIMEOUT_MS;
    for (;;) {
      if (typeof operation?.id !== "number" || typeof operation.status !== "string") {
        throw invalid(path);
      }
      if (operation.status === "succeeded") return operation;
      if (!OPEN_OPERATION_STATUSES.has(operation.status)) {
        throw new OrbitGatewayError({
          code:
            typeof operation.error_code === "string" ? operation.error_code : "operation.failed",
          message: `The Orbit Gateway could not finish ${path}: the Operation ${operation.status}.`,
          status: 0,
          details: { operation_id: operation.id },
        });
      }
      if (now() >= deadline) {
        throw new OrbitGatewayError({
          code: "operation.timeout",
          message: `The Orbit Gateway did not finish ${path} in time.`,
          status: 0,
          details: { operation_id: operation.id },
        });
      }
      const wait = operationPollDelayMs(
        typeof operation.poll_after_seconds === "number" ? operation.poll_after_seconds : null,
      );
      await sleep(Math.max(Math.min(wait, deadline - now()), 0));
      operation = record(await call({ method: "GET", path: `/operations/${operation.id}` }));
    }
  };

  return {
    me: async () => node(await call({ method: "GET", path: "/me" }), "/me"),
    profiles: async () =>
      list(await call({ method: "GET", path: "/profiles" }), "/profiles", profile),
    createProfile: async (name) =>
      profile(await call({ method: "POST", path: "/profiles", body: { name } }), "/profiles"),
    bindProfile: async (profileId) =>
      node(
        await call({ method: "PUT", path: "/me/profile", body: { profile_id: profileId } }),
        "/me/profile",
      ),
    settings: async (profileId) =>
      settings(
        await call({ method: "GET", path: `/profiles/${profileId}/settings` }),
        "/profiles/settings",
      ),
    replaceWorkspaces: async (profileId, version, workspaces) =>
      settings(
        await call({
          method: "PUT",
          path: `/profiles/${profileId}/settings`,
          body: { version, settings: { workspaces: workspaces.map(toWire) } },
        }),
        "/profiles/settings",
      ),
    patchSections: async (profileId, sections) =>
      settings(
        await call({
          method: "PATCH",
          path: `/profiles/${profileId}/settings`,
          body: { sections },
        }),
        "/profiles/settings",
      ),
    environments: async () =>
      list(await call({ method: "GET", path: "/environments" }), "/environments", environment),
    threads: async () => {
      const envelope = await callEnvelope({ method: "GET", path: "/threads" });
      const index = parseOrbitThreadIndex(envelope.data, envelope.meta);
      if (index === null) throw invalid("/threads");
      return index;
    },
    pair: async (environmentId, pairOptions) => {
      const path = `/environments/${encodeURIComponent(environmentId)}/pairings`;
      let data = record(
        await call({
          method: "POST",
          path,
          timeoutMs: ADMISSION_TIMEOUT_MS,
          ...(pairOptions?.renew ? { body: { renew: true } } : {}),
        }),
      );
      // The Gateway mints the link in an Operation (202). Follow it, then read the link once.
      if (typeof data?.pairing_url !== "string") {
        const result = record((await settle(data, path)).result);
        if (typeof result?.pairing_id !== "number") throw invalid(path);
        data = record(await call({ method: "GET", path: `${path}/${result.pairing_id}` }));
      }
      return issuedPairing(data, path);
    },
    projects: async (options) =>
      list(
        await call({
          method: "GET",
          path: "/projects",
          ...(options?.includeUnavailable ? { query: { include_unavailable: "1" } } : {}),
        }),
        "/projects",
        project,
      ),
    checkInstanceName: async (projectId, name) => {
      const path = `/projects/${projectId}/instances/check`;
      return instanceNameCheck(
        await call({ method: "GET", path, query: { name }, timeoutMs: NAME_CHECK_TIMEOUT_MS }),
        name,
        path,
      );
    },
    createThreadInstance: async (projectId, name, idempotencyKey, branch) => {
      const path = `/projects/${projectId}/instances`;
      return operation(
        await call({
          method: "POST",
          path,
          body: branch ? { name, branch: branchBody(branch) } : { name },
          timeoutMs: ADMISSION_TIMEOUT_MS,
          idempotencyKey,
        }),
        path,
      );
    },
    branches: async (projectId, query) => {
      const path = `/projects/${projectId}/branches`;
      const trimmed = query.trim();
      const envelope = await callEnvelope({
        method: "GET",
        path,
        ...(trimmed === "" ? {} : { query: { query: trimmed } }),
        timeoutMs: BRANCHES_TIMEOUT_MS,
      });
      if (!Array.isArray(envelope.data)) throw invalid(path);
      return {
        branches: envelope.data.flatMap(branch),
        pullRequestsUnavailable: record(envelope.meta)?.pull_requests_unavailable === true,
      };
    },
    operation: async (operationId) => {
      const path = `/operations/${operationId}`;
      return operation(await call({ method: "GET", path }), path);
    },
    cancelOperation: async (operationId) => {
      const path = `/operations/${operationId}/cancel`;
      return operation(await call({ method: "POST", path, body: {} }), path);
    },
    startPairing: async (environmentId, idempotencyKey) => {
      const path = `/environments/${encodeURIComponent(environmentId)}/pairings`;
      return operation(
        await call({ method: "POST", path, timeoutMs: ADMISSION_TIMEOUT_MS, idempotencyKey }),
        path,
      );
    },
    readPairing: async (environmentId, pairingId) => {
      const path = `/environments/${encodeURIComponent(environmentId)}/pairings/${pairingId}`;
      return issuedPairing(await call({ method: "GET", path }), path);
    },
    completeInstance: async (instanceId, idempotencyKey) => {
      const path = `/instances/${instanceId}/complete`;
      return operation(
        await call({ method: "POST", path, timeoutMs: ADMISSION_TIMEOUT_MS, idempotencyKey }),
        path,
      );
    },
    destroyInstance: async (instanceId, acknowledgeUnsaved, idempotencyKey) => {
      const path = `/instances/${instanceId}/destroy`;
      return operation(
        await call({
          method: "POST",
          path,
          body: { acknowledge_unsaved: acknowledgeUnsaved },
          timeoutMs: ADMISSION_TIMEOUT_MS,
          idempotencyKey,
        }),
        path,
      );
    },
    instanceGit: async (instanceId, timeoutMs) =>
      call({ method: "GET", path: `/instances/${instanceId}/work`, timeoutMs }),
    wakeInstance: async (instanceId, idempotencyKey) => {
      const path = `/instances/${instanceId}/wake`;
      return wakeOperation(
        await call({ method: "POST", path, body: {}, idempotencyKey, root: true }),
        path,
      );
    },
    wakeOperation: async (operationId) => {
      const path = `/operations/${operationId}`;
      return wakeOperation(await call({ method: "GET", path, root: true }), path);
    },
  };
}

function wakeOperation(value: unknown, path: string): OrbitGatewayWakeOperation {
  const data = record(value);
  if (typeof data?.id !== "number" || typeof data.status !== "string") throw invalid(path);
  return {
    id: data.id,
    status: data.status,
    errorCode: typeof data.error_code === "string" ? data.error_code : null,
    pollAfterSeconds: typeof data.poll_after_seconds === "number" ? data.poll_after_seconds : null,
  };
}

function issuedPairing(value: unknown, path: string): OrbitGatewayPairing {
  const data = record(value);
  const pairing = record(data?.pairing);
  if (
    typeof data?.pairing_url !== "string" ||
    typeof pairing?.environment_id !== "string" ||
    typeof pairing.expires_at !== "string"
  ) {
    throw invalid(path);
  }
  return {
    environmentId: pairing.environment_id,
    pairingUrl: data.pairing_url,
    expiresAt: pairing.expires_at,
  };
}

const OPERATION_STATUSES: ReadonlySet<string> = new Set([
  "queued",
  "running",
  "waiting",
  ...OPERATION_TERMINAL_STATUSES,
]);

function operation(value: unknown, path: string): OrbitGatewayOperation {
  const data = record(value);
  if (
    typeof data?.id !== "number" ||
    typeof data.kind !== "string" ||
    typeof data.status !== "string" ||
    !OPERATION_STATUSES.has(data.status) ||
    typeof data.target_id !== "number"
  ) {
    throw invalid(path);
  }
  return {
    id: data.id,
    kind: data.kind,
    status: data.status as OrbitGatewayOperation["status"],
    targetId: data.target_id,
    errorCode: typeof data.error_code === "string" ? data.error_code : null,
    pollAfterSeconds: typeof data.poll_after_seconds === "number" ? data.poll_after_seconds : null,
    ...(Array.isArray(data.steps) ? { steps: data.steps.flatMap(operationStep) } : {}),
    ...("current_step" in data ? { currentStep: optionalText(data.current_step) } : {}),
    ...("current_step_started_at" in data
      ? { currentStepStartedAt: optionalText(data.current_step_started_at) }
      : {}),
    ...("failed_step" in data ? { failedStep: optionalText(data.failed_step) } : {}),
    ...("error" in data ? { error: operationError(data.error) } : {}),
    ...("result" in data ? { result: record(data.result) } : {}),
    ...processFailure(data.result),
    ...recovery(data.result),
    ...completionFields(data),
    ...("capacity_wait" in data ? { capacityWait: record(data.capacity_wait) !== null } : {}),
  };
}

function processFailure(result: unknown): { processFailureUnit?: string | null } {
  const failure = record(record(result)?.process_failure);
  return failure === null ? {} : { processFailureUnit: optionalText(failure.unit) };
}

/** The Gateway writes `requires` under `recovery.retry` (Orbit's InstanceCompleteProjection). */
function recovery(result: unknown): {
  recoveryRequires?: string | null;
  recoveryRetryable?: boolean;
} {
  const value = record(record(result)?.recovery);
  if (value === null) return {};
  const retry = record(value.retry);
  return { recoveryRequires: optionalText(retry?.requires), recoveryRetryable: retry !== null };
}

function completionFields(data: Record<string, unknown>): Partial<OrbitGatewayOperation> {
  const result = record(data.result);
  const input = record(data.input);
  return {
    ...(result !== null && "completion_operation_id" in result
      ? {
          completionOperationId:
            typeof result.completion_operation_id === "number"
              ? result.completion_operation_id
              : null,
        }
      : {}),
    ...(input !== null && "route_id" in input
      ? { routeId: typeof input.route_id === "number" ? input.route_id : null }
      : {}),
    ...(result !== null && "failed_step" in result
      ? { resultFailedStep: optionalText(result.failed_step) }
      : {}),
    ...("cancel_requested" in data ? { cancelRequested: data.cancel_requested === true } : {}),
  };
}

function operationStep(value: unknown): OrbitGatewayOperationStep[] {
  const data = record(value);
  const name = optionalText(data?.name);
  const status = optionalText(data?.status);
  if (name === null || status === null) return [];
  return [
    {
      name,
      ...(data !== null && "group" in data ? { group: optionalText(data.group) } : {}),
      job: optionalText(data?.job),
      status,
      startedAt: optionalText(data?.started_at),
      finishedAt: optionalText(data?.finished_at),
    },
  ];
}

/** The Operation's error: an object with a code and a message, or a bare message. */
function operationError(value: unknown): OrbitGatewayOperationError | null {
  if (typeof value === "string") return { code: null, message: gatewayText(value), detail: null };
  const data = record(value);
  if (data === null) return null;
  return {
    code: optionalText(data.code),
    message: optionalText(data.message),
    detail: optionalText(data.detail),
  };
}

function project(value: unknown, path: string): OrbitGatewayProjectListing {
  const data = record(value);
  if (
    typeof data?.id !== "number" ||
    typeof data.slug !== "string" ||
    typeof data.name !== "string"
  ) {
    throw invalid(path);
  }
  return {
    id: data.id,
    slug: data.slug,
    name: data.name,
    nodeId: typeof data.node_id === "number" ? data.node_id : null,
    nodeName: optionalText(data.node_name),
    instanceDomainSuffix: optionalText(data.instance_domain_suffix),
    cloneable: data.cloneable !== false,
    cloneableReason: optionalText(data.cloneable_reason),
    checks: Array.isArray(data.checks) ? data.checks.flatMap(projectCheck) : null,
  };
}

/** Only the keys Orbit takes for each mode: it refuses extra keys. */
function branchBody(selection: OrbitGatewayBranchSelection): OrbitGatewayBranchSelection {
  return selection.mode === "new"
    ? { mode: "new", from: selection.from }
    : { mode: "existing", name: selection.name };
}

/** A branch without a name is dropped; a malformed PR or Instance reads as none. */
function branch(value: unknown): OrbitGatewayBranch[] {
  const data = record(value);
  const name = optionalText(data?.name);
  if (data === null || name === null) return [];
  const pullRequest = record(data.pull_request);
  const instance = record(data.instance);
  return [
    {
      name,
      default: data.default === true,
      pullRequest:
        typeof pullRequest?.number === "number"
          ? {
              number: pullRequest.number,
              title: optionalText(pullRequest.title),
              url: optionalText(pullRequest.url),
            }
          : null,
      instance:
        typeof instance?.id === "number" && optionalText(instance.name) !== null
          ? { id: instance.id, name: optionalText(instance.name)! }
          : null,
    },
  ];
}

const INSTANCE_NAME_REASONS: ReadonlySet<string> = new Set([
  "taken",
  "invalid",
  "default",
  "domain_invalid",
]);

/** Only `available` is required; a missing name reads as the one asked about. */
function instanceNameCheck(
  value: unknown,
  requested: string,
  path: string,
): OrbitGatewayInstanceNameCheck {
  const data = record(value);
  if (typeof data?.available !== "boolean") throw invalid(path);
  const reason =
    typeof data.reason === "string" && INSTANCE_NAME_REASONS.has(data.reason)
      ? (data.reason as OrbitGatewayInstanceNameReason)
      : null;
  return {
    name: optionalText(data.name) ?? requested,
    available: data.available,
    reason: data.available ? null : reason,
    domain: optionalText(data.domain),
  };
}

const PROJECT_CHECK_STATUSES = new Set(["pass", "fail", "not_checked"]);

/** A check with an unknown status or no key is dropped rather than failing the list. */
function projectCheck(value: unknown): OrbitGatewayProjectCheck[] {
  const data = record(value);
  const key = optionalText(data?.key);
  const status = data?.status;
  if (key === null || typeof status !== "string" || !PROJECT_CHECK_STATUSES.has(status)) return [];
  return [
    {
      key,
      label: optionalText(data?.label),
      status: status as OrbitGatewayProjectCheck["status"],
      code: optionalText(data?.code),
      message: optionalText(data?.message),
    },
  ];
}

/** Whether a `pair` failure is one the Gateway calls final, so the caller must not retry it. */
export function isFinalPairingError(error: unknown): boolean {
  return isOrbitGatewayError(error) && FINAL_PAIRING_ERROR_CODES.has(error.code);
}

/** Whether Orbit refused a renewal because this Node's pairing with the server is revoked. */
export function isPairingRevokedError(error: unknown): boolean {
  return isOrbitGatewayError(error) && error.code === PAIRING_REVOKED;
}

const isOrbitGatewayError = Schema.is(OrbitGatewayError);

/** The message of an `OrbitGatewayError` whose reply carried no error envelope message. */
export function gatewayFallbackMessage(status: number): string {
  return `The Orbit Gateway answered ${status}.`;
}

/** A string the way the Gateway stores it: trimmed, and null when nothing is left. */
export function gatewayText(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function gatewayTexts(values: readonly string[] | undefined): string[] {
  return (values ?? []).flatMap((value) => gatewayText(value) ?? []);
}

/**
 * The wire form of a workspace: only the keys the Gateway accepts, with strings as it stores
 * them (an empty icon or image is null), so a read-back equals what was sent.
 */
function toWire(workspace: OrbitGatewayWorkspace): OrbitGatewayWorkspace {
  return {
    id: workspace.id.trim(),
    name: workspace.name.trim(),
    color: workspace.color.trim(),
    icon: gatewayText(workspace.icon),
    image: gatewayText(workspace.image),
    projectRefs: gatewayTexts(workspace.projectRefs),
    projectKeys: gatewayTexts(workspace.projectKeys),
  };
}

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function invalid(path: string): OrbitGatewayError {
  return new OrbitGatewayError({
    code: "gateway.response_invalid",
    message: `The Orbit Gateway sent an unexpected ${path} response.`,
    status: 0,
    details: {},
  });
}

function list<T>(value: unknown, path: string, item: (value: unknown, path: string) => T): T[] {
  if (!Array.isArray(value)) throw invalid(path);
  return value.map((entry) => item(entry, path));
}

function profile(value: unknown, path: string): OrbitGatewayProfile {
  const data = record(value);
  if (
    typeof data?.id !== "number" ||
    typeof data.name !== "string" ||
    typeof data.settings_version !== "number" ||
    typeof data.updated_at !== "string"
  ) {
    throw invalid(path);
  }
  return {
    id: data.id,
    name: data.name,
    settingsVersion: data.settings_version,
    updatedAt: data.updated_at,
  };
}

function node(value: unknown, path: string): OrbitGatewayNode {
  const data = record(value);
  if (
    typeof data?.id !== "number" ||
    typeof data.name !== "string" ||
    (data.wireguard_ip !== undefined &&
      data.wireguard_ip !== null &&
      typeof data.wireguard_ip !== "string")
  ) {
    throw invalid(path);
  }
  return {
    id: data.id,
    name: data.name,
    // A Node without an address reads as "" so the Connection page can say the device is not known.
    wireguardIp: gatewayText(data.wireguard_ip) ?? "",
    profile:
      data.profile === null || data.profile === undefined ? null : profile(data.profile, path),
    profileChannel: isConnProfileChannel(data.profile_channel) ? data.profile_channel : null,
  };
}

/** A channel name of the form the Gateway issues: `private-conn-profile.{key}`. */
function isConnProfileChannel(value: unknown): value is string {
  return typeof value === "string" && /^private-conn-profile\.[0-9a-f]{32}$/.test(value);
}

function settings(value: unknown, path: string): OrbitGatewaySettings {
  const data = record(value);
  const document = record(data?.settings);
  const workspaces = document?.workspaces;
  if (
    document === null ||
    typeof data?.profile_id !== "number" ||
    typeof data.version !== "number" ||
    typeof data.updated_at !== "string" ||
    !Array.isArray(workspaces)
  ) {
    throw invalid(path);
  }
  return {
    profileId: data.profile_id,
    version: data.version,
    updatedAt: data.updated_at,
    workspaces: workspaces.map((entry) => workspace(entry, path)),
    document,
    sections: sectionMetas(data.sections),
  };
}

function sectionMetas(value: unknown): Record<string, OrbitGatewaySectionMeta> | null {
  const data = record(value);
  if (data === null) return null;
  const sections: Record<string, OrbitGatewaySectionMeta> = {};
  for (const [name, entry] of Object.entries(data)) {
    const meta = record(entry);
    if (typeof meta?.version !== "number") continue;
    const by = meta.updated_by;
    sections[name] = {
      version: meta.version,
      updatedAt: typeof meta.updated_at === "string" ? meta.updated_at : null,
      updatedBy:
        typeof by === "string"
          ? by
          : typeof record(by)?.name === "string"
            ? (record(by)!.name as string)
            : null,
    };
  }
  return sections;
}

function strings(value: unknown, path: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw invalid(path);
  }
  return value as string[];
}

function workspace(value: unknown, path: string): OrbitGatewayWorkspace {
  const data = record(value);
  if (
    typeof data?.id !== "string" ||
    typeof data.name !== "string" ||
    typeof data.color !== "string" ||
    (data.icon !== null && typeof data.icon !== "string") ||
    (data.image !== undefined && data.image !== null && typeof data.image !== "string")
  ) {
    throw invalid(path);
  }
  const projectRefs = strings(data.projectRefs, path);
  const projectKeys = strings(data.projectKeys, path);
  return {
    id: data.id,
    name: data.name,
    color: data.color,
    icon: data.icon as string | null,
    image: (data.image as string | null | undefined) ?? null,
    ...(projectRefs ? { projectRefs } : {}),
    ...(projectKeys ? { projectKeys } : {}),
  };
}

function environment(value: unknown, path: string): OrbitGatewayEnvironment {
  const data = record(value);
  if (
    typeof data?.environment_id !== "string" ||
    typeof data.label !== "string" ||
    typeof data.url !== "string" ||
    (data.status !== "registered" && data.status !== "session_expired")
  ) {
    throw invalid(path);
  }
  return {
    environmentId: data.environment_id,
    label: data.label,
    url: data.url,
    serverVersion: typeof data.server_version === "string" ? data.server_version : null,
    registeredBy: typeof data.registered_by === "string" ? data.registered_by : null,
    registeredAt: typeof data.registered_at === "string" ? data.registered_at : null,
    status: data.status,
    instanceId: typeof data.instance_id === "number" ? data.instance_id : null,
    powerState:
      data.power_state === "running" || data.power_state === "stopped" ? data.power_state : null,
    projectId: typeof data.project_id === "number" ? data.project_id : null,
    projectName: optionalText(data.project_name),
    projectSlug: optionalText(data.project_slug),
    instanceName: optionalText(data.instance_name),
    nodeName: optionalText(data.node_name),
    instanceUrl: optionalText(data.instance_url),
  };
}

/** A trimmed string, or null for anything else (absent, empty or another type). */
function optionalText(value: unknown): string | null {
  return typeof value === "string" ? gatewayText(value) : null;
}

// Conn (thread-index plan, C3): the answer of `GET /conn/threads`.
/** One thread of the index, as the Gateway lists it. */
export interface OrbitThreadIndexRow {
  readonly environmentId: string;
  readonly instanceId: number;
  readonly projectId: number;
  readonly threadId: string;
  readonly title: string;
  /** T3's thread status (`idle`, `running`, `completed`, …); null until the Gateway read the server. */
  readonly state: string | null;
  readonly needsInput: boolean;
  readonly lastUserMessageAt: string | null;
  readonly lastRunCompletedAt: string | null;
  readonly seenAt: string;
}

/** One covered server of the index (`meta.environments`). */
export interface OrbitThreadIndexEnvironment {
  readonly environmentId: string;
  readonly instanceId: number;
  readonly powerState: string;
  /** When the Gateway last read this server; null when it never did. */
  readonly readAt: string | null;
  readonly readError: string | null;
}

export interface OrbitThreadIndex {
  readonly rows: readonly OrbitThreadIndexRow[];
  readonly environments: readonly OrbitThreadIndexEnvironment[];
}

const indexNullableString = (value: unknown): string | null =>
  typeof value === "string" ? value : null;

function indexRow(value: unknown): OrbitThreadIndexRow | null {
  const data = record(value);
  if (
    typeof data?.environment_id !== "string" ||
    typeof data.instance_id !== "number" ||
    typeof data.project_id !== "number" ||
    typeof data.thread_id !== "string" ||
    typeof data.title !== "string" ||
    typeof data.seen_at !== "string"
  ) {
    return null;
  }
  return {
    environmentId: data.environment_id,
    instanceId: data.instance_id,
    projectId: data.project_id,
    threadId: data.thread_id,
    title: data.title,
    state: indexNullableString(data.state),
    needsInput: data.needs_input === true,
    lastUserMessageAt: indexNullableString(data.last_user_message_at),
    lastRunCompletedAt: indexNullableString(data.last_run_completed_at),
    seenAt: data.seen_at,
  };
}

function indexEnvironment(value: unknown): OrbitThreadIndexEnvironment | null {
  const data = record(value);
  if (typeof data?.environment_id !== "string" || typeof data.instance_id !== "number") return null;
  return {
    environmentId: data.environment_id,
    instanceId: data.instance_id,
    powerState: typeof data.power_state === "string" ? data.power_state : "running",
    readAt: indexNullableString(data.read_at),
    readError: indexNullableString(data.read_error),
  };
}

/**
 * Reads the envelope's `data` and `meta.environments`; null when either is not a list. A row or
 * server entry that is not one is left out, so one odd row does not hide the rest.
 */
export function parseOrbitThreadIndex(data: unknown, meta: unknown): OrbitThreadIndex | null {
  const environments = record(meta)?.environments;
  if (!Array.isArray(data) || !Array.isArray(environments)) return null;
  return {
    rows: data.flatMap((entry) => indexRow(entry) ?? []),
    environments: environments.flatMap((entry) => indexEnvironment(entry) ?? []),
  };
}
