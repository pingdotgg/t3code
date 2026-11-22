import type { OrbitInstanceWakeOutcome } from "./instanceWake.ts";
import {
  ModelSelection,
  ProviderInteractionMode,
  RuntimeMode,
  type ModelSelection as ModelSelectionType,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  OPERATION_TERMINAL_STATUSES,
  OPERATION_TIMEOUT_MS,
  ORBIT_BRANCH_EXISTS,
  ORBIT_CONTAINER_PROCESS_INACTIVE,
  ORBIT_RECOVERY_REQUIRES_PROCESS_DEFINITION,
  ORBIT_BRANCH_IN_USE,
  ORBIT_BRANCH_NOT_FOUND,
  ORBIT_PLACEMENT_CONFLICT,
  ORBIT_ROUTE_DOMAIN_INVALID,
  ORBIT_SOURCE_HEAD_UNAVAILABLE,
  OrbitGatewayError,
  ORBIT_RESERVATION_FINALIZED,
  operationPollDelayMs,
  type OrbitGatewayBranchSelection,
  type OrbitGatewayClient,
  type OrbitGatewayOperation,
  type OrbitGatewayProject,
} from "./client.ts";
import { waitForOperationRead, type OrbitOperationNotices } from "./operationNotices.ts";
import type { OrbitReservationPairing, TakenOrbitReservation } from "./reservations.ts";
import {
  observeOrbitCreateRows,
  readSavedOrbitCreateRows,
  stopRunningOrbitCreateRows,
  sameOrbitCreateRows,
  type OrbitCreateRows,
} from "./orbitCreateRows.ts";

/**
 * Conn: a thread started in an Orbit Project (Orbit's docs/cli/instance/container/thread.mmd). The
 * Gateway creates a clone of the Project's default Instance, Conn pairs with the clone's T3 server
 * once, and sends the first message there. Each finished step is saved, so a reload resumes the
 * same start instead of creating or pairing again.
 */
export interface OrbitThreadStart {
  readonly id: string;
  readonly projectId: number;
  readonly projectSlug: string;
  readonly nodeName: string;
  readonly instanceName: string;
  readonly message: string;
  /**
   * The thread, its first message and the launch command, fixed up front. A resumed send repeats
   * the same command, so the server finishes that launch instead of starting a second one.
   */
  readonly threadId: string;
  readonly messageId: string;
  readonly commandId: string;
  readonly createdAt: number;
  /** Conn: the workspace selected at Start (null for all); the sent thread's project joins it. */
  readonly workspaceId?: string | null;
  /**
   * The `Idempotency-Key` of the create and of the pairing, saved before the first try, so a
   * repeat after a lost answer, a reload or Retry gets the same Operation. Missing on older rows.
   */
  readonly createKey?: string | null;
  readonly createOperationId: number | null;
  readonly instanceId: number | null;
  readonly environmentId: string | null;
  readonly pairingKey?: string | null;
  readonly pairingOperationId: number | null;
  readonly pairingId: number | null;
  /** Conn read the one-time pairing link. A resume that finds it with an unsaved server waits for Retry. */
  readonly pairingLinkRead: boolean;
  /** The device saved the clone's server: paired now or before. */
  readonly connected: boolean;
  /** Why the start stopped. A retry resumes from the last saved step. */
  readonly error: string | null;
  // Version 2. Rows saved by older builds lack these fields; `readOrbitThreadStarts` loads them.
  /** "existing": the start begins at a known clone and skips the create. Missing means "new". */
  readonly orbitInstanceKind?: OrbitInstanceKind;
  /** The composer's model and modes for the first turn; null or missing uses the clone's defaults. */
  readonly modelSelection?: ModelSelectionType | null;
  readonly runtimeMode?: RuntimeMode | null;
  readonly interactionMode?: ProviderInteractionMode | null;
  /** The Gateway's error code behind `error`, such as `instance.name_taken`. */
  readonly errorCode?: string | null;
  /** Stage times in ms, saved as each stage begins and ends. */
  readonly createStartedAt?: number | null;
  readonly createFinishedAt?: number | null;
  readonly connectStartedAt?: number | null;
  readonly connectFinishedAt?: number | null;
  readonly agentStartedAt?: number | null;
  readonly sentAt?: number | null;
  /**
   * The start opened a pending thread (the palette flow). It stays saved after the send, so the
   * real thread finds it by `threadId` for its "Instance ready" row. Older and dialog starts lack it.
   * The phone sets it after the send when the create has a completion, for its start row.
   */
  readonly pendingThread?: boolean;
  /** Display facts for the pending thread and Change name; null on older rows. */
  readonly projectName?: string | null;
  readonly instanceDomainSuffix?: string | null;
  /** The clone did not offer the composer's model; the first turn used the clone's default. */
  readonly modelFallback?: OrbitModelFallback | null;
  /**
   * The branch the new Instance works on; null or missing clones the default branch as before.
   * Retry sends the same one: Orbit refuses the same name with another selection.
   */
  readonly branch?: OrbitGatewayBranchSelection | null;
  /** The Project's default branch as the draft knew it at send, or null. */
  readonly defaultBranch?: string | null;
  /** The Gateway's `details` behind `errorCode`, such as the Instance holding a branch. */
  readonly errorDetails?: Readonly<Record<string, unknown>> | null;
  /** Orbit's detail line from the failed Operation behind `errorCode`; null on older rows. */
  readonly errorDetail?: string | null;
  /** The Project process that did not stay up, from a failed create's `result.process_failure`. */
  readonly errorProcessUnit?: string | null;
  /** What a failed create needs before a Retry works (`result.recovery.requires`); null when unsaid. */
  readonly errorRecoveryRequires?: string | null;
  /** The create's result: the branch the Instance checked out and the base it was cut from. */
  readonly resultBranch?: string | null;
  readonly resultBaseBranch?: string | null;
  /**
   * The random suffix of a name Conn made from the message; null for a typed or existing name.
   * Before the create the runner may shorten that name's slug, keeping the suffix.
   */
  readonly nameSuffix?: string | null;
  /**
   * The rows under "Create Instance", saved as the runner reads the create Operation, so the card
   * shows them after a reload; null on older rows.
   */
  readonly createRows?: OrbitCreateRows | null;
  /**
   * Cancel came while the create was being admitted: the runner cancels the Operation Orbit
   * admits, then drops the start. Only the UI sets it; Retry clears it.
   */
  readonly cancelRequested?: boolean;
  /**
   * The create's `instance.complete` (Orbit release 2030): it sets up the workspace and the address
   * after the thread is usable. Null or missing on older Gateways: then nothing follows the create.
   * Its outcome is saved here, never in `error`, so `connected` and the composer stay as they are.
   */
  readonly completionOperationId?: number | null;
  /**
   * Conn: the pre-warmed clone (`OrbitReservations.take`) this start finalizes instead of creating
   * one; null or missing creates as before. Cleared when the start falls back to a create.
   */
  readonly reservationId?: string | null;
  /** The reserved clone's server, hidden in every list until the finalize succeeded. */
  readonly reservedEnvironmentId?: string | null;
  /** The key of the last Retry of the completion, saved before the call. */
  readonly completionKey?: string | null;
  readonly completionStatus?: OrbitGatewayOperation["status"] | null;
  readonly completionErrorCode?: string | null;
  readonly completionErrorDetail?: string | null;
  readonly completionProcessUnit?: string | null;
  /** `result.recovery.retry.requires` of the failed completion. */
  readonly completionRequires?: string | null;
  /** `result.recovery.retry` was present: Orbit takes a Retry. */
  readonly completionRetryable?: boolean;
}

/** A name whose address `<name>.<project domain>` Orbit refuses (check or create). */
export const ORBIT_NAME_DOMAIN_INVALID_TEXT =
  "This name makes the address too long. Use a shorter name.";

export interface OrbitModelFallback {
  readonly requestedModel: string;
  readonly usedModel: string;
}

export type OrbitInstanceKind = "new" | "existing";

/** A clone the device knows already; a start in it skips the create. */
export interface OrbitExistingInstance {
  readonly instanceId: number;
  readonly environmentId: string;
  readonly name: string;
  readonly nodeName: string;
}

const STAGE_TIME_FIELDS = [
  "createStartedAt",
  "createFinishedAt",
  "connectStartedAt",
  "connectFinishedAt",
  "agentStartedAt",
  "sentAt",
] as const;

const decodeModelSelection = Schema.decodeUnknownOption(ModelSelection);
const isRuntimeMode = Schema.is(RuntimeMode);
const isInteractionMode = Schema.is(ProviderInteractionMode);

/**
 * The starts a store saved, from rows of any build. Rows without the ids a resume needs are
 * dropped; version 2 fields with a wrong type read as missing.
 */
export function readOrbitThreadStarts(value: unknown): OrbitThreadStart[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry: unknown): OrbitThreadStart[] => {
    if (typeof entry !== "object" || entry === null) return [];
    const row = entry as Record<string, unknown>;
    if (
      typeof row.id !== "string" ||
      typeof row.commandId !== "string" ||
      typeof row.threadId !== "string" ||
      typeof row.projectId !== "number" ||
      // A start the palette's plus saved without a message (conn#79) no longer runs: every new
      // Instance starts with a first prompt.
      (typeof row.message === "string" && row.message.trim() === "")
    ) {
      return [];
    }
    const times = Object.fromEntries(
      STAGE_TIME_FIELDS.map((field) => [
        field,
        typeof row[field] === "number" ? (row[field] as number) : null,
      ]),
    );
    return [
      {
        ...(row as unknown as OrbitThreadStart),
        ...times,
        orbitInstanceKind: row.orbitInstanceKind === "existing" ? "existing" : "new",
        modelSelection: Option.getOrNull(decodeModelSelection(row.modelSelection)),
        runtimeMode: isRuntimeMode(row.runtimeMode) ? row.runtimeMode : null,
        interactionMode: isInteractionMode(row.interactionMode) ? row.interactionMode : null,
        errorCode: typeof row.errorCode === "string" ? row.errorCode : null,
        pendingThread: row.pendingThread === true,
        projectName: typeof row.projectName === "string" ? row.projectName : null,
        instanceDomainSuffix:
          typeof row.instanceDomainSuffix === "string" ? row.instanceDomainSuffix : null,
        modelFallback: readModelFallback(row.modelFallback),
        branch: readBranchSelection(row.branch),
        defaultBranch: typeof row.defaultBranch === "string" ? row.defaultBranch : null,
        errorDetails:
          typeof row.errorDetails === "object" &&
          row.errorDetails !== null &&
          !Array.isArray(row.errorDetails)
            ? (row.errorDetails as Record<string, unknown>)
            : null,
        errorDetail: typeof row.errorDetail === "string" ? row.errorDetail : null,
        errorProcessUnit: typeof row.errorProcessUnit === "string" ? row.errorProcessUnit : null,
        errorRecoveryRequires:
          typeof row.errorRecoveryRequires === "string" ? row.errorRecoveryRequires : null,
        resultBranch: typeof row.resultBranch === "string" ? row.resultBranch : null,
        resultBaseBranch: typeof row.resultBaseBranch === "string" ? row.resultBaseBranch : null,
        nameSuffix: typeof row.nameSuffix === "string" ? row.nameSuffix : null,
        createRows: readSavedOrbitCreateRows(row.createRows),
        cancelRequested: row.cancelRequested === true,
        completionOperationId:
          typeof row.completionOperationId === "number" ? row.completionOperationId : null,
        completionKey: typeof row.completionKey === "string" ? row.completionKey : null,
        completionStatus: OPERATION_STATUS_WORDS.has(row.completionStatus as string)
          ? (row.completionStatus as OrbitGatewayOperation["status"])
          : null,
        completionErrorCode: optionalString(row.completionErrorCode),
        completionErrorDetail: optionalString(row.completionErrorDetail),
        completionProcessUnit: optionalString(row.completionProcessUnit),
        completionRequires: optionalString(row.completionRequires),
        completionRetryable: row.completionRetryable === true,
        reservationId: optionalString(row.reservationId),
        reservedEnvironmentId: optionalString(row.reservedEnvironmentId),
      },
    ];
  });
}

const OPERATION_STATUS_WORDS: ReadonlySet<string> = new Set([
  "queued",
  "running",
  "waiting",
  ...OPERATION_TERMINAL_STATUSES,
]);

const optionalString = (value: unknown): string | null =>
  typeof value === "string" ? value : null;

/** A saved branch choice, or null for none or a broken one. */
function readBranchSelection(value: unknown): OrbitGatewayBranchSelection | null {
  if (typeof value !== "object" || value === null) return null;
  const row = value as Record<string, unknown>;
  if (row.mode === "new" && typeof row.from === "string" && row.from !== "") {
    return { mode: "new", from: row.from };
  }
  if (row.mode === "existing" && typeof row.name === "string" && row.name !== "") {
    return { mode: "existing", name: row.name };
  }
  return null;
}

function readModelFallback(value: unknown): OrbitModelFallback | null {
  if (typeof value !== "object" || value === null) return null;
  const { requestedModel, usedModel } = value as Record<string, unknown>;
  return typeof requestedModel === "string" && typeof usedModel === "string"
    ? { requestedModel, usedModel }
    : null;
}

/**
 * The start Retry runs again: no error, and the times of each stage that runs again cleared, so
 * the stage shows pending until the runner reaches it and its time counts from the new attempt.
 * `patch` applies first, such as a new Instance name.
 */
export function retryOrbitThreadStartRecord(
  start: OrbitThreadStart,
  patch: Partial<OrbitThreadStart> = {},
): OrbitThreadStart {
  const next = {
    ...start,
    ...patch,
    error: null,
    errorCode: null,
    errorDetails: null,
    errorDetail: null,
    errorProcessUnit: null,
    errorRecoveryRequires: null,
    cancelRequested: false,
  };
  const createAgain = next.environmentId === null;
  return {
    ...next,
    ...(createAgain && next.createOperationId === null
      ? { createStartedAt: null, createFinishedAt: null, createRows: null }
      : {}),
    ...(next.connected ? {} : { connectStartedAt: null, connectFinishedAt: null }),
    ...(next.sentAt == null ? { agentStartedAt: null } : {}),
  };
}

/**
 * Retry runs the start again. A process that did not stay up fails the same way on the kept
 * Instance, unless Orbit says the retry takes the Project's current process definitions.
 */
export function orbitThreadStartCanRetry(start: OrbitThreadStart): boolean {
  return (
    start.errorCode !== ORBIT_CONTAINER_PROCESS_INACTIVE ||
    start.errorRecoveryRequires === ORBIT_RECOVERY_REQUIRES_PROCESS_DEFINITION
  );
}

/**
 * Whether the start made an Instance that stays when the start is dismissed: its create was
 * admitted (Orbit holds the Instance, also after a failed create) or it finished. A start in an
 * existing Instance made none.
 */
export function orbitThreadStartCreatedInstance(start: OrbitThreadStart): boolean {
  return (
    start.orbitInstanceKind !== "existing" &&
    (start.instanceId !== null || start.environmentId !== null)
  );
}

export interface OrbitThreadStartPorts {
  readonly client: OrbitGatewayClient;
  /** Saves the start after each step. */
  readonly save: (start: OrbitThreadStart) => void;
  readonly sleep: (ms: number) => Promise<void>;
  readonly now: () => number;
  /** True once the user dismissed the start, or Orbit no longer provides the environments. */
  readonly stopped: () => boolean;
  /** A dismissal abandons provisional pairing; a pause keeps it for the next run. */
  readonly dismissed?: (() => boolean) | undefined;
  readonly reservationPairing?: OrbitReservationPairing | undefined;
  /** Whether the device has saved the server already. */
  readonly isSaved: (environmentId: string) => boolean;
  /** Lets the draft finish its last reservation read and install before the start reads it. */
  readonly waitForReservationPairing?:
    | ((reservationId: string) => Promise<void> | undefined)
    | undefined;
  /**
   * Names checked while the user typed (`createOrbitInstanceNameFits`). A start whose name was
   * checked already skips the check; any other name is checked at send as before.
   */
  readonly nameFits?: OrbitInstanceNameFits | undefined;
  /** Whether the user pressed Cancel while the create was being admitted. */
  readonly cancelRequested?: () => boolean;
  /** The runner cancelled the create Orbit admitted for a Cancel; the start is to be dropped. */
  readonly cancelled?: () => void;
  /** Each read of the create Operation, for the setup card's clone step. */
  readonly onCreateOperation?: (operation: OrbitGatewayOperation) => void;
  /**
   * Conn: wakes an asleep Instance before Conn pairs with or connects to it. Without it, an asleep
   * Instance stops the start as before.
   */
  readonly wake?: (instanceId: number) => Promise<OrbitInstanceWakeOutcome>;
  /** Opens a one-time pairing link and saves the server. */
  readonly connect: (
    environmentId: string,
    pairingUrl: string,
    installId?: string,
  ) => Promise<void>;
  /**
   * Starts the thread with the first message in the clone's workspace project. It may resolve facts
   * to save with the sent start, such as a model fallback.
   */
  readonly send: (
    start: OrbitThreadStart & { readonly environmentId: string },
  ) => Promise<void | Partial<OrbitThreadStart>>;
}

/** The longest name the Gateway takes is 63 characters; the slug leaves room for the suffix. */
const NAME_SLUG_LENGTH = 40;
/** Shorter slugs to try when Orbit says the address of the name is too long, then "thread". */
const NAME_SLUG_RETRY_LENGTHS = [24, 12, 0];
const NAME_SLUG_WORDS = 6;
/** How long Operation reads may keep failing before the start stops. */
const READ_OUTAGE_MS = 60_000;
/** A clone's create runs for minutes; a pairing follows #9's `pair` deadline. */
const CREATE_TIMEOUT_MS = 30 * 60_000;
const PAIRING_TIMEOUT_MS = OPERATION_TIMEOUT_MS;
/**
 * The user waits on the create and the pairing, which end in seconds: Orbit's 2 s hint would see
 * each end up to 2 s late. Conn reads them this often for their first minute, then by the hint.
 */
const WAITED_POLL_MS = 500;
const WAITED_POLL_WINDOW_MS = 60_000;
/**
 * A create seen running this recently ended moments ago, so its clone is awake. After a longer
 * gap (a sleeping laptop) the clone may sleep too: Conn lists it and wakes it.
 */
const CREATED_SERVER_FRESH_MS = 60_000;
/** How long a pairing admission may keep losing its answer; each try may take up to 60 s. */
const PAIRING_ADMISSION_MS = 5 * 60_000;

/**
 * The clone's Instance name: the first words of the message as a slug, and a random suffix so two
 * threads with the same opening never name the same Instance.
 */
export function orbitThreadInstanceName(
  message: string,
  suffix: string,
  slugLength = NAME_SLUG_LENGTH,
): string {
  const slug = message
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/[\s-]+/)
    .filter((word) => word !== "")
    .slice(0, NAME_SLUG_WORDS)
    .join("-")
    .slice(0, slugLength)
    .replace(/-+$/, "");
  return `${slug || "thread"}-${suffix}`;
}

/** The names a derived start tries in order, all with the same suffix: slug cut to 40, 24, 12, then "thread". */
function orbitThreadInstanceNameTries(message: string, suffix: string): string[] {
  const names = [NAME_SLUG_LENGTH, ...NAME_SLUG_RETRY_LENGTHS].map((length) =>
    orbitThreadInstanceName(message, suffix, length),
  );
  return [...new Set(names)];
}

/** A name that fits Orbit's address limits, or a refusal of every shorter try. */
export type OrbitInstanceNameFit =
  | { readonly kind: "fits"; readonly name: string }
  | { readonly kind: "refused" };

/**
 * Checks the names a message makes, longest first, while Orbit answers `domain_invalid`. Null
 * when a check failed before any such answer: the name is then left to the create.
 */
async function fitOrbitThreadInstanceName(
  client: Pick<OrbitGatewayClient, "checkInstanceName">,
  projectId: number,
  message: string,
  suffix: string,
  beforeCheck: () => void = () => {},
  /** A check that fails after a refusal is unknown (null) instead of refusing every name. */
  explicitOnly = false,
): Promise<OrbitInstanceNameFit | null> {
  let refused = false;
  for (const name of orbitThreadInstanceNameTries(message, suffix)) {
    beforeCheck();
    let answer;
    try {
      answer = await client.checkInstanceName(projectId, name);
    } catch {
      if (!refused || explicitOnly) return null;
      break;
    }
    if (answer.reason !== "domain_invalid") return { kind: "fits", name };
    refused = true;
  }
  return { kind: "refused" };
}

/** Conn: the name check of a derived name, run while the user types instead of at send. */
export interface OrbitInstanceNameFits {
  /** Checks the names the message makes; the same names are checked once. */
  readonly prefetch: (projectId: number, message: string, suffix: string) => void;
  /**
   * The answer for exactly these names: undefined when never checked, a promise while the check
   * runs. It resolves null when the check failed, so the send checks again.
   */
  readonly lookup: (
    projectId: number,
    message: string,
    suffix: string,
  ) => Promise<OrbitInstanceNameFit | null> | undefined;
}

/** Keeps the last few checks; a changed message that makes other names checks again. */
const NAME_FIT_CACHE_SIZE = 8;

export function createOrbitInstanceNameFits(
  client: Pick<OrbitGatewayClient, "checkInstanceName">,
): OrbitInstanceNameFits {
  const checks = new Map<string, Promise<OrbitInstanceNameFit | null>>();
  const key = (projectId: number, message: string, suffix: string) =>
    `${projectId}\n${orbitThreadInstanceNameTries(message, suffix).join("\n")}`;
  return {
    prefetch: (projectId, message, suffix) => {
      if (message.trim() === "") return;
      const id = key(projectId, message, suffix);
      if (checks.has(id)) return;
      // Kept only when Orbit answered: a refusal is cached only if it refused every name.
      const check = fitOrbitThreadInstanceName(
        client,
        projectId,
        message,
        suffix,
        undefined,
        true,
      ).catch(() => null);
      checks.set(id, check);
      // A failed check is not kept: the send or the next keystroke checks again.
      void check.then((fit) => {
        if (fit === null && checks.get(id) === check) checks.delete(id);
      });
      while (checks.size > NAME_FIT_CACHE_SIZE) checks.delete(checks.keys().next().value!);
    },
    lookup: (projectId, message, suffix) => checks.get(key(projectId, message, suffix)),
  };
}

export function newOrbitThreadStart(input: {
  readonly id: string;
  readonly project: Pick<OrbitGatewayProject, "id" | "slug" | "nodeName">;
  readonly message: string;
  readonly suffix: string;
  readonly threadId: string;
  readonly messageId: string;
  readonly commandId: string;
  readonly now: number;
  /** The name the user gave the new Instance; without it the name comes from the message. */
  readonly instanceName?: string;
  /** Starts in this clone instead of creating one. */
  readonly existing?: OrbitExistingInstance;
  readonly modelSelection?: ModelSelectionType | null;
  readonly runtimeMode?: RuntimeMode | null;
  readonly interactionMode?: ProviderInteractionMode | null;
  readonly pendingThread?: boolean;
  readonly projectName?: string | null;
  readonly instanceDomainSuffix?: string | null;
  /** A new Instance only; ignored for an existing one. */
  readonly branch?: OrbitGatewayBranchSelection | null;
  readonly defaultBranch?: string | null;
  /** A new Instance only: the reservation the send took, finalized instead of a create. */
  readonly reservation?: TakenOrbitReservation | null;
}): OrbitThreadStart {
  const existing = input.existing;
  return {
    id: input.id,
    projectId: input.project.id,
    projectSlug: input.project.slug,
    nodeName: existing?.nodeName ?? input.project.nodeName,
    instanceName:
      existing?.name ?? input.instanceName ?? orbitThreadInstanceName(input.message, input.suffix),
    message: input.message,
    threadId: input.threadId,
    messageId: input.messageId,
    commandId: input.commandId,
    createdAt: input.now,
    createKey: null,
    createOperationId: null,
    instanceId: existing?.instanceId ?? null,
    environmentId: existing?.environmentId ?? null,
    pairingKey: null,
    pairingOperationId: null,
    pairingId: null,
    pairingLinkRead: false,
    connected: false,
    error: null,
    orbitInstanceKind: existing ? "existing" : "new",
    modelSelection: input.modelSelection ?? null,
    runtimeMode: input.runtimeMode ?? null,
    interactionMode: input.interactionMode ?? null,
    errorCode: null,
    createStartedAt: null,
    createFinishedAt: null,
    connectStartedAt: null,
    connectFinishedAt: null,
    agentStartedAt: null,
    sentAt: null,
    pendingThread: input.pendingThread ?? false,
    projectName: input.projectName ?? null,
    instanceDomainSuffix: input.instanceDomainSuffix ?? null,
    modelFallback: null,
    branch: existing ? null : (input.branch ?? null),
    defaultBranch: input.defaultBranch ?? null,
    errorDetails: null,
    errorDetail: null,
    errorProcessUnit: null,
    errorRecoveryRequires: null,
    resultBranch: null,
    resultBaseBranch: null,
    nameSuffix: existing || input.instanceName !== undefined ? null : input.suffix,
    createRows: null,
    completionOperationId: null,
    reservationId: existing ? null : (input.reservation?.reservationId ?? null),
    reservedEnvironmentId: existing ? null : (input.reservation?.environmentId ?? null),
  };
}

/**
 * The reserved clone's server while the start finalizes it, or null. Lists hide it until then, as
 * they hide every reserved clone.
 */
export function orbitThreadStartHiddenEnvironmentId(start: OrbitThreadStart): string | null {
  return start.reservationId && start.environmentId === null
    ? (start.reservedEnvironmentId ?? null)
    : null;
}

/** Reservations whose pending start was removed. A finalized server belongs to the catalog. */
export function dismissedOrbitReservationIds(
  previous: readonly OrbitThreadStart[],
  current: readonly OrbitThreadStart[],
): string[] {
  const remaining = new Set(current.map((start) => start.id));
  return previous.flatMap((start) =>
    start.reservationId && start.environmentId === null && !remaining.has(start.id)
      ? [start.reservationId]
      : [],
  );
}

/** The step a start is at, for display. */
export function orbitThreadStartStep(start: OrbitThreadStart): "creating" | "pairing" | "sending" {
  if (start.environmentId === null) return "creating";
  return start.connected ? "sending" : "pairing";
}

/** A step that stopped the start, with the saved steps a retry must redo. */
class StepFailed extends Schema.TaggedError<StepFailed>()("OrbitThreadStepFailed", {
  message: Schema.String,
  code: Schema.NullOr(Schema.String),
  reset: Schema.Record(Schema.String, Schema.Unknown),
  details: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  detail: Schema.optional(Schema.NullOr(Schema.String)),
}) {}

/** The user dismissed the start. */
class Stopped extends Schema.TaggedError<Stopped>()("OrbitThreadStartStopped", {}) {}

const isStepFailed = Schema.is(StepFailed);
const isStopped = Schema.is(Stopped);
const isOrbitGatewayError = Schema.is(OrbitGatewayError);

/** The Gateway did not answer, or failed on its side. */
function isTransient(error: unknown): boolean {
  return isOrbitGatewayError(error) && (error.status === 0 || error.status >= 500);
}

/**
 * An admission whose answer was lost on the way: no answer, or a proxy's 502/504 without the
 * Gateway's error envelope. A Gateway error, also a 5xx, is final.
 */
function isLostAdmission(error: unknown): boolean {
  return (
    isOrbitGatewayError(error) &&
    (error.status === 0 ||
      ((error.status === 502 || error.status === 504) && error.code === "gateway.request_failed"))
  );
}

/**
 * Another Operation owns the Instance, such as an older build's create or one whose key was lost.
 * The same create is admitted once that Operation ends.
 */
function isTargetBusy(error: unknown): boolean {
  return (
    isOrbitGatewayError(error) && error.status === 409 && error.code === "operation.target_busy"
  );
}

type OrbitCancelClient = Pick<OrbitGatewayClient, "cancelOperation" | "operation">;

/**
 * Asks Orbit to stop an Operation. A refusal because it already ended reads it: the read
 * Operation is returned when it ended; else the refusal stands.
 */
async function cancelOrRead(
  client: OrbitCancelClient,
  operationId: number,
): Promise<OrbitGatewayOperation> {
  try {
    return await client.cancelOperation(operationId);
  } catch (error) {
    const read = await client.operation(operationId).catch(() => null);
    if (read === null || !OPERATION_TERMINAL_STATUSES.has(read.status)) throw error;
    return read;
  }
}

/**
 * Cancels a start's `instance.complete` (Orbit release 2063). A completion that already ended is
 * left as it is; any other refusal throws.
 */
export async function cancelOrbitCompletion(
  client: OrbitCancelClient,
  completionOperationId: number,
): Promise<void> {
  await cancelOrRead(client, completionOperationId);
}

/**
 * Cancels a start's create (Orbit release 2063). A create that already succeeded has admitted its
 * completion (`result.completion_operation_id`): that one is cancelled too. A create that ended
 * otherwise needs nothing more; a refusal of a create that still runs (such as an older
 * Gateway's 404) throws.
 */
export async function cancelOrbitCreate(
  client: OrbitCancelClient,
  createOperationId: number,
): Promise<void> {
  const create = await cancelOrRead(client, createOperationId);
  if (create.status === "succeeded" && typeof create.completionOperationId === "number") {
    await cancelOrbitCompletion(client, create.completionOperationId);
  }
}

/** Conn: the start's text for an asleep Instance when Conn cannot wake it (no port, older Gateway). */
const ORBIT_CLONE_ASLEEP_TEXT = "The clone is asleep. Conn cannot wake it yet.";

/** Conn: wakes the Instance through the port, or fails the step as an asleep clone did before. */
async function wakeClone(ports: OrbitThreadStartPorts, instanceId: number): Promise<void> {
  const outcome = ports.wake === undefined ? null : await ports.wake(instanceId);
  if (outcome?.kind === "awake") return;
  if (outcome === null || outcome.kind === "unsupported") {
    throw stepFailed(ORBIT_CLONE_ASLEEP_TEXT, {});
  }
  throw stepFailed(
    `Orbit could not wake the clone (${outcome.code}).`,
    {},
    outcome.code,
    outcome.message,
  );
}

function stepFailed(
  message: string,
  reset: Partial<OrbitThreadStart>,
  code: string | null = null,
  detail: string | null = null,
): StepFailed {
  return new StepFailed({ message, code, reset, detail });
}

/**
 * Refusals of a create at admission: Orbit made no Instance, so a retry or another name or branch
 * is a new attempt under a new key.
 */
const ADMISSION_REFUSALS: ReadonlySet<string> = new Set([
  "instance.name_taken",
  ORBIT_BRANCH_IN_USE,
  ORBIT_BRANCH_NOT_FOUND,
  ORBIT_BRANCH_EXISTS,
  ORBIT_SOURCE_HEAD_UNAVAILABLE,
  ORBIT_PLACEMENT_CONFLICT,
  ORBIT_ROUTE_DOMAIN_INVALID,
  // A malformed request (such as a branch object Orbit refuses) admits nothing either.
  "validation.failed",
]);

function isAdmissionRefusal(error: unknown): error is OrbitGatewayError {
  return isOrbitGatewayError(error) && ADMISSION_REFUSALS.has(error.code);
}

/** The reservation is gone for this caller: released, expired, or another's. */
function isReservationGone(error: unknown): boolean {
  return (
    isOrbitGatewayError(error) &&
    (error.status === 404 ||
      error.status === 410 ||
      (error.code.startsWith("reservation.") && error.code !== ORBIT_RESERVATION_FINALIZED))
  );
}

/**
 * A finalize ends about a second after its admission: the start reads it this often for its first
 * 2 s, then as any waited Operation.
 */
const FINALIZE_POLL_MS = 200;
const FAST_POLL_WINDOW_MS = 2_000;

/** A finalize that succeeded, and when it was last seen admitted or running (null after a resume). */
interface FinalizedReservation {
  readonly operation: OrbitGatewayOperation;
  readonly runningSeenAt: number | null;
}

/** How often a start waits on a reservation that is still preparing (a read is cheap). */
const RESERVATION_POLL_MS = 500;
/** How long a start waits for a reservation to become ready before it creates instead. */
const RESERVATION_WAIT_MS = 2 * 60_000;

/**
 * Runs a start from its last saved step to the sent message. Resolves `true` once the message is
 * sent; otherwise it saves the start with `error` set and resolves `false`.
 */
export async function runOrbitThreadStart(
  start: OrbitThreadStart,
  ports: OrbitThreadStartPorts,
): Promise<boolean> {
  let current: OrbitThreadStart = {
    ...start,
    error: null,
    errorCode: null,
    errorDetails: null,
    errorDetail: null,
    errorProcessUnit: null,
    errorRecoveryRequires: null,
  };
  const update = (patch: Partial<OrbitThreadStart>) => {
    current = { ...current, ...patch };
    ports.save(current);
  };
  /** A stage time, set once: a resume keeps the first. */
  const stamp = (field: (typeof STAGE_TIME_FIELDS)[number]): Partial<OrbitThreadStart> =>
    current[field] == null ? { [field]: ports.now() } : {};
  const checkStopped = () => {
    if (ports.stopped()) throw new Stopped();
  };
  /** Follows an Operation with the rules of #9's `settle`: clamped polls and a deadline. */
  const follow = async (
    operationId: number,
    timeoutMs: number,
    failed: (
      code: string,
      detail: string | null,
      operation: OrbitGatewayOperation | null,
    ) => StepFailed,
    observe?: (operation: OrbitGatewayOperation) => void,
    beforeRead?: () => Promise<void>,
    /** Reads this often for the first `FAST_POLL_WINDOW_MS`, for an Operation that ends in about a second. */
    fastPollMs?: number,
  ): Promise<OrbitGatewayOperation> => {
    const deadline = ports.now() + timeoutMs;
    const fastUntil = ports.now() + WAITED_POLL_WINDOW_MS;
    const fastestUntil = ports.now() + FAST_POLL_WINDOW_MS;
    let outageSince: number | null = null;
    let lastHint: number | null = null;
    let sequence: number | null = null;
    const notices = ports.client.operationNotices?.(operationId) ?? null;
    try {
      for (;;) {
        checkStopped();
        await beforeRead?.();
        let operation;
        try {
          operation = await ports.client.operation(operationId);
          outageSince = null;
          sequence = operation.sequence ?? sequence;
          observe?.(operation);
        } catch (error) {
          // A create runs for minutes; a short Gateway outage must not stop it.
          outageSince ??= ports.now();
          if (!isTransient(error) || ports.now() - outageSince >= READ_OUTAGE_MS) throw error;
          operation = null;
        }
        if (operation?.status === "succeeded") return operation;
        if (operation && OPERATION_TERMINAL_STATUSES.has(operation.status)) {
          throw failed(
            operation.errorCode ?? `operation.${operation.status}`,
            operation.error?.detail ?? null,
            operation,
          );
        }
        if (ports.now() >= deadline) throw failed("operation.timeout", null, null);
        if (operation !== null) lastHint = operation.pollAfterSeconds ?? lastHint;
        // A failed read keeps the last hint, so a failing Gateway is not read faster.
        const hinted = operationPollDelayMs(lastHint);
        const waited =
          fastPollMs !== undefined && ports.now() < fastestUntil ? fastPollMs : WAITED_POLL_MS;
        const wait =
          operation !== null && ports.now() < fastUntil ? Math.min(hinted, waited) : hinted;
        // A failed read retries on the poll wait; the next notice may never come.
        await waitForOperationRead({
          notices: operation === null ? null : notices,
          sequence,
          pollMs: wait,
          maxMs: deadline - ports.now(),
          sleep: ports.sleep,
        });
      }
    } finally {
      notices?.stop();
    }
  };

  /**
   * Starts an Operation under a saved key. A lost answer repeats the same request with a growing,
   * clamped wait until the deadline: the Gateway returns the Operation it may have admitted.
   */
  const admit = async (
    deadline: number,
    start: () => Promise<OrbitGatewayOperation>,
    repeats: (error: unknown) => boolean = isLostAdmission,
  ): Promise<OrbitGatewayOperation> => {
    for (let attempt = 0; ; attempt++) {
      checkStopped();
      try {
        return await start();
      } catch (error) {
        if (!repeats(error) || ports.now() >= deadline) throw error;
      }
      const wait = operationPollDelayMs(2 ** attempt);
      await ports.sleep(Math.max(Math.min(wait, deadline - ports.now()), 0));
    }
  };
  /** A Cancel that came during admission cancels the admitted create, then ends the start. */
  const cancelIfRequested = async (operationId: number) => {
    if (!ports.cancelRequested?.()) return;
    try {
      await cancelOrbitCreate(ports.client, operationId);
    } catch (error) {
      throw stepFailed(
        `Orbit could not cancel the create: ${error instanceof Error ? error.message : String(error)}`,
        {},
        isOrbitGatewayError(error) ? error.code : null,
      );
    }
    ports.cancelled?.();
    throw new Stopped();
  };
  const newKey = (step: string) => `conn-thread-start:${current.id}:${step}:${ports.now()}`;

  /**
   * A name Conn made from the message, checked once before a new create attempt: while Orbit
   * answers `domain_invalid`, the next shorter slug. A check that fails before any such answer
   * leaves the name to the create; after one, or when no name fits, the start stops.
   */
  const fitDerivedName = async (suffix: string) => {
    // The check that ran while the user typed, for these names; else it runs now.
    const typed = await ports.nameFits?.lookup(current.projectId, current.message, suffix);
    checkStopped();
    const fit =
      typed ??
      (await fitOrbitThreadInstanceName(
        ports.client,
        current.projectId,
        current.message,
        suffix,
        checkStopped,
      ));
    if (fit === null) return;
    if (fit.kind === "refused") {
      throw stepFailed(ORBIT_NAME_DOMAIN_INVALID_TEXT, {}, ORBIT_ROUTE_DOMAIN_INVALID);
    }
    if (fit.name !== current.instanceName) update({ instanceName: fit.name });
  };

  /**
   * Conn: a start with a reservation, before the create. It no longer holds one: the create runs as
   * before, with nothing on screen. Orbit removes the clone of a released reservation.
   */
  const abandonReservation = (reservationId: string) => {
    if (ports.reservationPairing) return ports.reservationPairing.abandon(reservationId);
    void ports.client.releaseReservation(reservationId).catch(() => null);
  };

  const fallBackToCreate = async () => {
    const reservationId = current.reservationId;
    if (reservationId) await abandonReservation(reservationId);
    checkStopped();
    update({
      reservationId: null,
      reservedEnvironmentId: null,
      createOperationId: null,
      createKey: null,
      createStartedAt: null,
      createRows: null,
      instanceId: null,
    });
  };

  /**
   * Conn: finalizes the start's reservation with the typed name and branch. Returns the succeeded
   * Operation, or null when the start must create instead (reservation expired, failed, gone, or
   * its finalize failed). Refusals of the name or branch stop the start as a create's would.
   */
  const finalizeReservation = async (deadline: number): Promise<FinalizedReservation | null> => {
    const reservationId = current.reservationId!;
    let admittedAt: number | null = null;
    if (current.createOperationId === null) {
      await ports.waitForReservationPairing?.(reservationId);
      const reserved = current.reservedEnvironmentId ?? null;
      // The draft paired with the clone once it was ready: no read is needed before the finalize.
      // A reservation that ended since is refused by the finalize, which falls back as below.
      const pairedWhileTyping = reserved !== null && ports.isSaved(reserved);
      // Wait until the clone is ready; a reservation that cannot become ready soon falls back.
      const readyBy = Math.min(deadline, ports.now() + RESERVATION_WAIT_MS);
      let instanceId: number | null = null;
      // A preparing reservation is ready once its create Operation succeeds: wait on its notices.
      let createNotices: OrbitOperationNotices | null = null;
      try {
        while (!pairedWhileTyping) {
          checkStopped();
          let reservation;
          try {
            reservation = await ports.client.reservation(reservationId);
          } catch (error) {
            if (isReservationGone(error) || !isTransient(error)) return null;
            reservation = null;
          }
          if (reservation !== null) {
            if (reservation.id !== reservationId || reservation.projectId !== current.projectId) {
              return null;
            }
            const replay = reservation.state === "finalized" && current.createKey != null;
            if (reservation.state === "ready" || reservation.state === "finalizing" || replay) {
              instanceId = reservation.instanceId;
              checkStopped();
              const { environmentId, pairing } = reservation;
              if (environmentId !== null) update({ reservedEnvironmentId: environmentId });
              checkStopped();
              if (
                reservation.state === "ready" &&
                pairing !== null &&
                environmentId === pairing.environmentId &&
                !ports.isSaved(environmentId)
              ) {
                // GET hands out the link once. Install it in memory before continuing the start.
                try {
                  const connect = (installId?: string) =>
                    ports.connect(environmentId, pairing.pairingUrl, installId);
                  if (ports.reservationPairing) {
                    await ports.reservationPairing.installPairing(
                      reservationId,
                      environmentId,
                      connect,
                    );
                  } else {
                    await connect();
                  }
                } catch {
                  // Pair explicitly after finalize if the server was not saved.
                }
              }
              break;
            }
            if (reservation.state !== "preparing") return null;
            if (createNotices === null && reservation.createOperationId !== null) {
              createNotices =
                ports.client.operationNotices?.(reservation.createOperationId) ?? null;
            }
          }
          if (ports.now() >= readyBy) return null;
          await waitForOperationRead({
            notices: reservation === null ? null : createNotices,
            sequence: null,
            pollMs: RESERVATION_POLL_MS,
            maxMs: readyBy - ports.now(),
            sleep: ports.sleep,
          });
        }
      } finally {
        createNotices?.stop();
      }
      checkStopped();
      // A name made from the message fits Orbit's address limits, as for a create.
      if (!current.createKey && current.nameSuffix) await fitDerivedName(current.nameSuffix);
      /** A key saved by an earlier run: the finalize below may replay its Operation. */
      const replayKey = current.createKey != null;
      const begin = current.createKey
        ? stamp("createStartedAt")
        : {
            createKey: newKey("finalize"),
            createStartedAt: ports.now(),
            createFinishedAt: null,
            createRows: null,
          };
      if (Object.keys(begin).length > 0) update(begin);
      let operation;
      try {
        operation = await admit(deadline, () =>
          ports.client.finalizeReservation(
            reservationId,
            current.instanceName,
            current.createKey!,
            current.branch ?? null,
          ),
        );
      } catch (error) {
        if (isAdmissionRefusal(error)) {
          throw new StepFailed({
            message:
              error.code === ORBIT_ROUTE_DOMAIN_INVALID
                ? ORBIT_NAME_DOMAIN_INVALID_TEXT
                : error.message,
            code: error.code,
            reset: { createKey: null },
            details: error.details,
          });
        }
        if (isOrbitGatewayError(error) && !isLostAdmission(error)) return null;
        throw error;
      }
      // Only a finalize this call admitted counts as seen just now: a replay under a saved key may
      // return one that ended long ago, whose clone may sleep since.
      admittedAt =
        replayKey || OPERATION_TERMINAL_STATUSES.has(operation.status) ? null : ports.now();
      update({ createOperationId: operation.id, instanceId: instanceId ?? operation.targetId });
      await cancelIfRequested(operation.id);
    }
    try {
      const followed = await followCreate(deadline, FINALIZE_POLL_MS);
      return {
        operation: followed.operation,
        runningSeenAt: followed.runningSeenAt ?? admittedAt,
      };
    } catch (error) {
      // A finalize that failed leaves the send to a create; a timeout stops as a create's would.
      if (isStepFailed(error) && error.code !== "operation.timeout") return null;
      throw error;
    }
  };

  const followCreate = async (deadline: number, fastPollMs?: number) => {
    let runningSeenAt: number | null = null;
    const operation = await follow(
      current.createOperationId!,
      deadline - ports.now(),
      (code, detail, operation) =>
        stepFailed(
          `Orbit could not create the clone (${code}).`,
          {
            ...(code === "operation.timeout" ? {} : { createOperationId: null, createKey: null }),
            errorProcessUnit: operation?.processFailureUnit ?? null,
            errorRecoveryRequires: operation?.recoveryRequires ?? null,
          },
          code,
          detail,
        ),
      (operation) => {
        if (!OPERATION_TERMINAL_STATUSES.has(operation.status)) runningSeenAt = ports.now();
        const rows = observeOrbitCreateRows(current.createRows ?? null, operation, ports.now());
        if (!sameOrbitCreateRows(rows, current.createRows)) update({ createRows: rows });
        ports.onCreateOperation?.(operation);
      },
      () => cancelIfRequested(current.createOperationId!),
      fastPollMs,
    );
    return { operation, runningSeenAt: runningSeenAt as number | null };
  };

  try {
    checkStopped();
    if (current.environmentId === null) {
      let createDeadline = ports.now() + CREATE_TIMEOUT_MS;
      let finalized: FinalizedReservation | null = null;
      if (current.reservationId && current.orbitInstanceKind !== "existing") {
        finalized = await finalizeReservation(createDeadline);
        if (finalized === null) {
          await fallBackToCreate();
          // The create gets its full time, whatever the reservation took.
          createDeadline = ports.now() + CREATE_TIMEOUT_MS;
        } else {
          await ports.reservationPairing?.commitPairing(current.reservationId);
        }
      }
      if (finalized === null && current.createOperationId === null) {
        if (!current.createKey && current.nameSuffix) await fitDerivedName(current.nameSuffix);
        // A new key is a new attempt (first try, a new name, or after a failed create): its time
        // counts from now. A repeat under the saved key keeps the first time.
        const begin = current.createKey
          ? stamp("createStartedAt")
          : {
              createKey: newKey("create"),
              createStartedAt: ports.now(),
              createFinishedAt: null,
              createRows: null,
            };
        if (Object.keys(begin).length > 0) update(begin);
        let operation;
        try {
          operation = await admit(
            createDeadline,
            () =>
              ports.client.createThreadInstance(
                current.projectId,
                current.instanceName,
                current.createKey!,
                current.branch ?? null,
              ),
            (error) => isLostAdmission(error) || isTargetBusy(error),
          );
        } catch (error) {
          // A refused create admitted nothing: the next attempt needs a new key.
          if (isAdmissionRefusal(error)) {
            throw new StepFailed({
              message:
                error.code === ORBIT_ROUTE_DOMAIN_INVALID
                  ? ORBIT_NAME_DOMAIN_INVALID_TEXT
                  : error.message,
              code: error.code,
              reset: { createKey: null },
              details: error.details,
            });
          }
          if (!isTargetBusy(error)) throw error;
          throw stepFailed(
            "Orbit is still creating this clone; press Retry in a minute.",
            {},
            "operation.target_busy",
          );
        }
        update({ createOperationId: operation.id, instanceId: operation.targetId });
        await cancelIfRequested(operation.id);
      }
      // A failed clone resumes when the same name is created again, so a retry admits it anew
      // under a new key. A create still running past the deadline keeps its Operation.
      const { operation: created, runningSeenAt } =
        finalized ?? (await followCreate(createDeadline));
      const result = created.result ?? null;
      const t3 = result?.t3;
      // A finalize keeps the reserved clone's server, which the draft paired with.
      const createdServer = finalized
        ? (current.reservedEnvironmentId ?? null)
        : typeof t3 === "object" && t3 !== null && "environment_id" in t3
          ? t3.environment_id
          : null;
      let environmentId: string;
      if (
        runningSeenAt !== null &&
        ports.now() - runningSeenAt < CREATED_SERVER_FRESH_MS &&
        typeof createdServer === "string"
      ) {
        // The create ended moments ago: its server was registered and started just now.
        environmentId = createdServer;
      } else {
        const server = (await ports.client.environments()).find(
          (environment) => environment.instanceId === current.instanceId,
        );
        if (!server) {
          throw stepFailed("Orbit created the clone but lists no Conn Server for it.", {});
        }
        if (server.status !== "registered") {
          throw stepFailed("The clone's Conn Server registration expired.", {});
        }
        if (server.powerState === "stopped") await wakeClone(ports, current.instanceId!);
        environmentId = server.environmentId;
      }
      update({
        environmentId,
        reservedEnvironmentId: null,
        resultBranch: typeof result?.branch === "string" ? result.branch : null,
        resultBaseBranch: typeof result?.base_branch === "string" ? result.base_branch : null,
        // The completion runs on; the thread opens without waiting for it.
        ...(typeof created.completionOperationId === "number"
          ? { completionOperationId: created.completionOperationId, completionStatus: "queued" }
          : {}),
        ...stamp("createFinishedAt"),
      });
    }
    const environmentId = current.environmentId!;

    checkStopped();

    if (!current.connected) {
      const begin = stamp("connectStartedAt");
      if (Object.keys(begin).length > 0) update(begin);
      if (!ports.isSaved(environmentId)) {
        // The link was read before a reload or a failed connect: only Retry may pair again.
        if (current.pairingLinkRead) {
          throw stepFailed("Conn read the pairing link but did not save the clone's server.", {
            pairingLinkRead: false,
          });
        }
        if (current.pairingOperationId === null) {
          // Conn: an existing Instance may be asleep; its server cannot mint a link until it wakes.
          if (
            ports.wake !== undefined &&
            current.orbitInstanceKind === "existing" &&
            current.instanceId !== null
          ) {
            // A failed read changes nothing: the pairing then fails or succeeds as before.
            const listed = (await ports.client.environments().catch(() => [])).find(
              (environment) => environment.environmentId === environmentId,
            );
            if (listed?.powerState === "stopped") await wakeClone(ports, current.instanceId);
          }
          if (!current.pairingKey) update({ pairingKey: newKey("pairing") });
          const operation = await admit(ports.now() + PAIRING_ADMISSION_MS, () =>
            ports.client.startPairing(environmentId, current.pairingKey!),
          );
          update({ pairingOperationId: operation.id, pairingId: operation.targetId });
        }
        // A failed pairing needs a new pairing: only a retry starts it, under a new key.
        const newPairing = { pairingOperationId: null, pairingId: null, pairingKey: null };
        await follow(current.pairingOperationId!, PAIRING_TIMEOUT_MS, (code, detail) =>
          stepFailed(`Orbit could not pair with the clone (${code}).`, newPairing, code, detail),
        );
        let pairingUrl: string;
        try {
          pairingUrl = (await ports.client.readPairing(environmentId, current.pairingId!))
            .pairingUrl;
        } catch (error) {
          // The Gateway may have handed the link out before the read failed: Retry pairs anew.
          throw stepFailed(
            isOrbitGatewayError(error) && error.status === 409
              ? "The pairing link was already used or expired."
              : error instanceof Error
                ? error.message
                : String(error),
            newPairing,
          );
        }
        // The Gateway hands the link out once: a failed connect needs a new pairing.
        update({ ...newPairing, pairingLinkRead: true });
        try {
          await ports.connect(environmentId, pairingUrl);
        } catch (error) {
          throw stepFailed(error instanceof Error ? error.message : String(error), {
            pairingLinkRead: false,
          });
        }
      }
      update({ connected: true, pairingLinkRead: false, ...stamp("connectFinishedAt") });
    }

    checkStopped();
    const begin = stamp("agentStartedAt");
    if (Object.keys(begin).length > 0) update(begin);
    const sent = await ports.send({ ...current, environmentId });
    update({ ...sent, sentAt: ports.now() });
    return true;
  } catch (error) {
    // A start stopped mid-step ends without an error, so it resumes if it comes back.
    if (isStopped(error) || ports.stopped()) {
      if (current.reservationId && current.environmentId === null && ports.dismissed?.()) {
        await abandonReservation(current.reservationId);
      }
      return false;
    }
    // A create that timed out, or lost the Gateway, stops the row that ran at this time.
    const stoppedRows =
      current.environmentId === null && (!isStepFailed(error) || error.code === "operation.timeout")
        ? stopRunningOrbitCreateRows(current.createRows ?? null, ports.now())
        : null;
    update({
      ...(stoppedRows ? { createRows: stoppedRows } : {}),
      ...(isStepFailed(error) ? (error.reset as Partial<OrbitThreadStart>) : {}),
      error: error instanceof Error ? error.message : String(error),
      errorCode: isStepFailed(error) ? error.code : isOrbitGatewayError(error) ? error.code : null,
      errorDetails: isStepFailed(error)
        ? (error.details ?? null)
        : isOrbitGatewayError(error)
          ? error.details
          : null,
      errorDetail: isStepFailed(error) ? (error.detail ?? null) : null,
    });
    return false;
  }
}
