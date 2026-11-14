import {
  ORBIT_BRANCH_EXISTS,
  ORBIT_BRANCH_IN_USE,
  ORBIT_BRANCH_NOT_FOUND,
  ORBIT_CONTAINER_PROCESS_INACTIVE,
  ORBIT_CREATE_CLONE_FAILED,
  ORBIT_CREATE_WORKSPACE_FAILED,
  ORBIT_NAME_DOMAIN_INVALID_TEXT,
  ORBIT_PLACEMENT_CONFLICT,
  ORBIT_ROUTE_DOMAIN_INVALID,
  ORBIT_SOURCE_HEAD_UNAVAILABLE,
  orbitCompletionPhase,
  orbitCompletionProcessFailureCanRetry,
  orbitSetupStages,
  orbitThreadStartCanRetry,
  orbitThreadStartCreatedInstance,
  type OrbitCreateRowId,
  type OrbitCreateRowStatus,
  type OrbitGatewayOperation,
  type OrbitSetupStageId,
  type OrbitSetupStageStatus,
  type OrbitThreadStart,
} from "@t3tools/client-runtime/orbit-gateway";

/**
 * Conn: what the Orbit setup card shows, built on the client from the saved start and the latest
 * read of its create Operation. The clone's server does not exist yet, so nothing comes from a
 * T3 server, and the wire contract's worktree stage ids stay untouched.
 */
export interface OrbitSetupViewStage {
  readonly id: OrbitSetupStageId;
  readonly label: string;
  readonly status: OrbitSetupStageStatus;
  /** "Create Instance": the Node. */
  readonly detail: string | null;
  /** "Create Instance": its four rows until the address is live, or where the setup failed. */
  readonly rows: readonly OrbitSetupViewRow[] | null;
}

export interface OrbitSetupViewRow {
  readonly id: OrbitCreateRowId;
  readonly label: string;
  readonly status: OrbitCreateRowStatus;
  /** "Publish the address": the address, without its scheme. */
  readonly detail: string | null;
}

/** The running card's Details: what the start asked for, before Orbit answered. */
export interface OrbitSetupDetails {
  readonly instanceName: string;
  readonly nodeName: string;
  readonly branch: string;
  readonly baseBranch: string | null;
  readonly url: string | null;
}

export interface OrbitSetupView {
  readonly phase: "running" | "done" | "failed";
  readonly stages: readonly OrbitSetupViewStage[];
  readonly error: string | null;
  /** Orbit's code and detail line under the error, as `code · detail`, when Orbit sent a detail. */
  readonly errorDetailLine: string | null;
  /** Retry can succeed; a process that did not stay up fails the same way again. */
  readonly canRetry: boolean;
  /** A refusal that made no Instance: a taken name, a name too long for the address, or a branch. */
  readonly canChangeName: boolean;
  /** A branch that is gone or held: reopen the draft with the branch menu. */
  readonly canChangeBranch: boolean;
  /** The Instance that works on the branch, which the user can open instead. */
  readonly openInstance: { readonly id: number; readonly name: string } | null;
  /** The start made an Instance: Dismiss leaves it, and the card says so unless the error does. */
  readonly instanceStays: boolean;
  readonly details: OrbitSetupDetails;
  /** Cancel waits for Orbit to admit the create, so it can be cancelled. */
  readonly cancelling: boolean;
  /**
   * Details and Cancel show while the start runs before the thread opens. Once the thread is
   * open, the card only follows the address: no Details, no Cancel (the way to stop a completion
   * is to remove the Instance).
   */
  readonly canCancel: boolean;
}

export const ORBIT_SETUP_FAILED_TITLE = "Instance setup failed";
export const ORBIT_SETUP_RUNNING_TITLE = "Setting up Instance…";
export const ORBIT_INSTANCE_STAYS_LINE = "The Instance stays; remove it in Orbit.";
const NAME_TAKEN = "instance.name_taken";

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** The branch the start asked for: its own (named after the Instance) or the existing one. */
function requestedBranch(start: OrbitThreadStart): string {
  const branch = start.branch ?? null;
  if (branch === null) return start.defaultBranch ?? start.instanceName;
  return branch.mode === "new" ? start.instanceName : branch.name;
}

/** The holder in a `branch.in_use` refusal; empty when the holder's Node is out of reach. */
function branchHolder(start: OrbitThreadStart): { id: number; name: string } | null {
  const instance = record(record(start.errorDetails)?.instance);
  return typeof instance?.id === "number" && typeof instance.name === "string"
    ? { id: instance.id, name: instance.name }
    : null;
}

interface OrbitStartFailure {
  readonly message: string | null;
  readonly changeName: boolean;
  readonly changeBranch: boolean;
  readonly openInstance: { readonly id: number; readonly name: string } | null;
}

/**
 * The failed card's text and actions for a start's error code. Branch refusals come at admission,
 * where Orbit made nothing; the two create step codes come from a failed Operation whose Instance
 * stays, so they offer no Change name or Change branch.
 */
export function orbitStartFailure(
  start: OrbitThreadStart,
  canRetry: boolean = orbitThreadStartCanRetry(start),
): OrbitStartFailure {
  const none = { changeName: false, changeBranch: false, openInstance: null };
  const madeNothing = !orbitThreadStartCreatedInstance(start);
  const details = record(start.errorDetails);
  switch (start.errorCode) {
    case NAME_TAKEN:
      return { ...none, message: start.error, changeName: madeNothing };
    case ORBIT_BRANCH_IN_USE: {
      const holder = branchHolder(start);
      const branch = requestedBranch(start);
      return {
        message: holder
          ? `Instance ${holder.name} already works on ${branch}.`
          : `Another Instance already works on ${branch}.`,
        changeName: false,
        changeBranch: madeNothing,
        openInstance: holder,
      };
    }
    case ORBIT_BRANCH_NOT_FOUND: {
      // Mode new names only a base (field branch.from), mode existing only a branch (branch.name).
      const branch = start.branch ?? null;
      const name =
        branch === null
          ? requestedBranch(start)
          : branch.mode === "new"
            ? branch.from
            : branch.name;
      return { ...none, message: `Branch ${name} no longer exists.`, changeBranch: madeNothing };
    }
    case ORBIT_BRANCH_EXISTS: {
      const name = typeof details?.branch === "string" ? details.branch : start.instanceName;
      return {
        ...none,
        message: `A branch named ${name} already exists.`,
        changeName: madeNothing,
      };
    }
    case ORBIT_ROUTE_DOMAIN_INVALID:
      return { ...none, message: ORBIT_NAME_DOMAIN_INVALID_TEXT, changeName: madeNothing };
    case ORBIT_PLACEMENT_CONFLICT:
      return {
        ...none,
        message: "This name was already used with another branch. Choose another name.",
        changeName: madeNothing,
      };
    case ORBIT_SOURCE_HEAD_UNAVAILABLE:
      return { ...none, message: "Could not read the repository." };
    case ORBIT_CREATE_CLONE_FAILED:
      return {
        ...none,
        message: `Orbit could not create ${start.instanceName}: the clone operation failed on ${start.nodeName}.`,
      };
    case ORBIT_CREATE_WORKSPACE_FAILED:
      return { ...none, message: "Orbit could not set up the workspace." };
    case ORBIT_CONTAINER_PROCESS_INACTIVE: {
      const unit = start.errorProcessUnit?.trim();
      const next = canRetry
        ? "Change or remove this process in the Project's Orbit settings, then retry."
        : "Fix the Project, remove this Instance in Orbit, then create it again.";
      return {
        ...none,
        message: `A process of this Project did not start${unit ? `: ${unit}` : ""}. ${next}`,
      };
    }
    default:
      return { ...none, message: start.error };
  }
}

function orbitErrorDetailLine(start: OrbitThreadStart): string | null {
  const detail = start.errorDetail?.trim();
  if (!detail) return null;
  return start.errorCode ? `${start.errorCode} · ${detail}` : detail;
}

const STAGE_LABELS: Readonly<Record<OrbitSetupStageId, string>> = {
  create: "Create Instance",
  connect: "Connect",
  agent: "Start agent",
};

export function orbitSetupView(
  start: OrbitThreadStart,
  create: OrbitGatewayOperation | null = null,
): OrbitSetupView {
  const completion = orbitCompletionPhase(start);
  const details = orbitSetupDetails(start);
  const host = details.url?.replace(/^https?:\/\//, "") ?? null;
  const stages = orbitSetupStages({ start, create }).map((stage): OrbitSetupViewStage => ({
    id: stage.id,
    label: STAGE_LABELS[stage.id],
    status: stage.status,
    detail: stage.detail,
    rows:
      stage.rows?.map((row) => ({
        id: row.id,
        label: row.label,
        status: row.status,
        detail: row.id === "address" ? host : null,
      })) ?? null,
  }));
  if (start.error === null && completion === "failed") {
    return { ...orbitCompletionFailedView(start), stages, details };
  }
  const phase =
    start.error !== null
      ? "failed"
      : start.sentAt != null && (completion === "none" || completion === "succeeded")
        ? "done"
        : "running";
  const failed = phase === "failed";
  const newInstance = start.orbitInstanceKind !== "existing";
  const failure = failed ? orbitStartFailure(start) : null;
  return {
    phase,
    stages,
    error: failure?.message ?? start.error,
    errorDetailLine: failed ? orbitErrorDetailLine(start) : null,
    canRetry: failed && orbitThreadStartCanRetry(start),
    canChangeName: newInstance && (failure?.changeName ?? false),
    canChangeBranch: newInstance && (failure?.changeBranch ?? false),
    openInstance: failure?.openInstance ?? null,
    instanceStays:
      failed &&
      orbitThreadStartCreatedInstance(start) &&
      start.errorCode !== ORBIT_CONTAINER_PROCESS_INACTIVE,
    details,
    cancelling: phase === "running" && start.cancelRequested === true,
    canCancel: phase === "running" && start.sentAt == null,
  };
}

/** Completion codes with a Conn message; any other code shows only its detail line (spec Q2). */
const COMPLETION_MESSAGE_CODES: ReadonlySet<string> = new Set([
  ORBIT_CREATE_WORKSPACE_FAILED,
  ORBIT_CONTAINER_PROCESS_INACTIVE,
]);

/**
 * The card of a start whose completion failed: the create, Connect and Start agent stay done, the
 * thread stays usable, and Retry asks Orbit for a new completion. No Change name, Change branch or
 * Open: the Instance exists and works.
 */
function orbitCompletionFailedView(
  start: OrbitThreadStart,
): Omit<OrbitSetupView, "stages" | "details"> {
  const code = start.completionErrorCode ?? null;
  // The completion's fields in the shape the create's failure texts read.
  const asStart: OrbitThreadStart = {
    ...start,
    errorCode: code,
    errorDetail: start.completionErrorDetail ?? null,
    errorDetails: null,
    errorProcessUnit: start.completionProcessUnit ?? null,
    errorRecoveryRequires: start.completionRequires ?? null,
  };
  const message =
    code !== null && COMPLETION_MESSAGE_CODES.has(code)
      ? orbitStartFailure(asStart, orbitCompletionProcessFailureCanRetry(start)).message
      : null;
  return {
    phase: "failed",
    error: message,
    // Without Orbit's detail, the code alone, so the card names what failed.
    errorDetailLine: orbitErrorDetailLine(asStart) ?? (message === null ? code : null),
    canRetry: start.completionRetryable === true,
    canChangeName: false,
    canChangeBranch: false,
    openInstance: null,
    instanceStays: code !== ORBIT_CONTAINER_PROCESS_INACTIVE,
    cancelling: false,
    canCancel: false,
  };
}

function orbitSetupDetails(start: OrbitThreadStart): OrbitSetupDetails {
  const branch = start.branch ?? null;
  const suffix = start.instanceDomainSuffix ?? null;
  return {
    instanceName: start.instanceName,
    nodeName: start.nodeName,
    branch: requestedBranch(start),
    baseBranch: branch?.mode === "new" ? branch.from : null,
    url: suffix
      ? `https://${start.instanceName}${suffix.startsWith(".") ? "" : "."}${suffix}`
      : null,
  };
}

/** What the real thread shows above the agent's work once the start handed over. */
export interface OrbitReadyView {
  readonly instanceName: string;
  readonly nodeName: string;
  readonly url: string | null;
  /** The one assistant-style line Conn renders; never sent to the agent. */
  readonly readyLine: string;
  /** The model the agent uses instead of the composer's, or null. */
  readonly modelFallbackLine: string | null;
  /** From the create's result: the branch checked out, and the base (null in mode existing). */
  readonly branch: string | null;
  readonly baseBranch: string | null;
  /** Shown only when the checked-out code is not the default branch. */
  readonly dependenciesLine: string | null;
}

export const ORBIT_DEPENDENCIES_LINE = "Dependencies and build come from the default branch.";

/**
 * Orbit reruns no setup after the checkout yet, so the code differs from what dependencies and the
 * build came from when the Instance works on another branch, or cut its own from another base.
 * The base is the create result's when Orbit sent one, else the one asked for.
 */
function checksOutOtherCode(start: OrbitThreadStart): boolean {
  const branch = start.branch ?? null;
  if (branch === null) return false;
  if (branch.mode === "existing") return true;
  return (start.resultBaseBranch ?? branch.from) !== start.defaultBranch;
}

export function orbitReadyView(start: OrbitThreadStart, url: string | null): OrbitReadyView {
  const fallback = start.modelFallback ?? null;
  return {
    instanceName: start.instanceName,
    nodeName: start.nodeName,
    url,
    readyLine: orbitReadyLine(url),
    modelFallbackLine: fallback
      ? `This Instance does not offer ${fallback.requestedModel}, so the agent uses ${fallback.usedModel}.`
      : null,
    branch: start.resultBranch ?? null,
    baseBranch: start.resultBaseBranch ?? null,
    dependenciesLine: checksOutOtherCode(start) ? ORBIT_DEPENDENCIES_LINE : null,
  };
}

export function orbitReadyLine(url: string | null): string {
  return url === null
    ? "Your Instance is ready."
    : `Your Instance is ready. You can preview it at ${url} while I work on your request.`;
}
