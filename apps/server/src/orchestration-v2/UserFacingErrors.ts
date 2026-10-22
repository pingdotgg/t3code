import {
  type OrchestrationV2DispatchRejectionReason,
  PROVIDER_DISPLAY_NAMES,
  type ProviderDriverKind,
} from "@t3tools/contracts";
import * as Predicate from "effect/Predicate";
import * as SqlError from "effect/sql/SqlError";

const GENERIC_ERROR_PREFIXES = [
  "Failed to dispatch orchestration V2 command",
  "Failed to dispatch orchestration command ",
  "Provider adapter failed while dispatching orchestration command ",
];

const SQLITE_RECOVERY_MESSAGES: Readonly<Record<number, string>> = {
  5: "The T3 Code server database is busy (SQLITE_BUSY). Wait a moment, then retry. If this keeps happening, check for another T3 Code process using the same data directory on the server.",
  6: "The T3 Code server database is locked (SQLITE_LOCKED). Wait a moment, then retry. If this keeps happening, check the server logs for the process holding the database lock.",
  8: "The T3 Code server database is read-only (SQLITE_READONLY). On the machine running the server, check that its data directory is writable and its disk is mounted read-write, then retry.",
  10: "The T3 Code server could not read or write its database (SQLITE_IOERR). On the machine running the server, check free disk space and disk health, then retry. If it still fails, check the server logs.",
  11: "The T3 Code server database appears damaged (SQLITE_CORRUPT). Preserve the server data directory and check the server logs before restoring a database backup.",
  13: "The T3 Code server could not save this change because its database or disk is full (SQLITE_FULL). Free space on the machine running the server, then retry. If space is available, check the server logs for a database size limit.",
  14: "The T3 Code server could not open a database file (SQLITE_CANTOPEN). On the machine running the server, check free disk space and that its data and temporary directories exist and are writable, then retry. If it still fails, check the server logs.",
  26: "The T3 Code server could not read its database file (SQLITE_NOTADB). Preserve the server data directory and check the configured database path and server logs before restoring a database backup.",
};

function databaseErrorMessage(value: unknown): string | undefined {
  if (!SqlError.isSqlError(value)) return undefined;

  let cause: unknown = value.cause;
  const seen = new Set<unknown>();
  while (Predicate.isObject(cause) && !seen.has(cause)) {
    seen.add(cause);
    // node:sqlite uses extended result codes; their low byte is the primary code.
    if (typeof cause.errcode === "number" && Number.isInteger(cause.errcode) && cause.errcode > 0) {
      const message = SQLITE_RECOVERY_MESSAGES[cause.errcode & 0xff];
      if (message !== undefined) return message;
    }
    cause = cause.cause;
  }

  return "The T3 Code server could not complete this database request. Retry once; if it still fails, check the server logs for the database error.";
}

const CAPABILITY_REJECTION_MESSAGES: Record<string, (provider: string) => string> = {
  queued_messages: (p) => `${p} cannot queue messages behind an active run.`,
  active_steering: (p) =>
    `${p} cannot redirect an active run. Stop it first, then send the message.`,
  interrupt_restart_steering: (p) =>
    `${p} cannot redirect an active run. Stop it first, then send the message.`,
  interrupt: (p) => `${p} cannot stop a run once it has started.`,
  native_fork: (p) => `${p} cannot fork this thread natively.`,
  fork_from_turn: (p) => `${p} cannot fork from an earlier point in this thread.`,
  rollback: (p) =>
    `${p} cannot rewind its conversation, so this checkpoint cannot be restored on this thread.`,
  rollback_snapshot: (p) =>
    `${p} did not report its rewound conversation state, so the checkpoint was not restored.`,
  context_handoff: (p) => `${p} cannot receive the context handoff needed for this switch.`,
  strong_terminal_status: (p) =>
    `${p} cannot confirm when its runs finish reliably enough for this.`,
};

function providerDisplayName(instanceId: string): string {
  const known = PROVIDER_DISPLAY_NAMES[instanceId as ProviderDriverKind];
  if (known !== undefined) return known;
  const trimmed = instanceId.replace(/Agent$/i, "").trim();
  if (trimmed.length === 0) return instanceId;
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}

function policyRejectionMessage(value: unknown): string | undefined {
  if (!Predicate.isObject(value) || typeof value.providerInstanceId !== "string") return undefined;
  const provider = providerDisplayName(value.providerInstanceId);
  if (value._tag === "CommandPolicyCapabilityUnsupportedError") {
    const capability = typeof value.capability === "string" ? value.capability : "";
    return CAPABILITY_REJECTION_MESSAGES[capability]?.(provider);
  }
  if (value._tag === "CommandPolicyUnsupportedError") {
    return `${provider} cannot deliver a message that way right now.`;
  }
  return undefined;
}

function textValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function messageFrom(value: unknown): string | undefined {
  if (typeof value === "string") {
    return textValue(value);
  }
  const friendly = policyRejectionMessage(value);
  if (friendly !== undefined) {
    return friendly;
  }
  if (value instanceof Error) {
    return textValue(value.message);
  }
  if (!Predicate.isObject(value)) {
    return undefined;
  }
  return textValue(value.detail) ?? textValue(value.message);
}

function isGenericErrorMessage(message: string): boolean {
  return GENERIC_ERROR_PREFIXES.some((prefix) => message.startsWith(prefix));
}

function collectErrorMessages(value: unknown, seen: Set<unknown>): ReadonlyArray<string> {
  if (value === undefined || value === null || seen.has(value)) {
    return [];
  }
  seen.add(value);

  if (Array.isArray(value)) {
    return value.flatMap((item) => collectErrorMessages(item, seen));
  }

  const databaseMessage = databaseErrorMessage(value);
  if (databaseMessage !== undefined) return [databaseMessage];

  const message = messageFrom(value);
  if (!Predicate.isObject(value)) {
    return message === undefined ? [] : [message];
  }

  const nested = [
    ...collectErrorMessages(value.cause, seen),
    ...collectErrorMessages(value.error, seen),
    ...collectErrorMessages(value.errors, seen),
  ];

  return message === undefined ? nested : [message, ...nested];
}

/** The first rejection reason in the cause chain, for clients that act on it. */
export function dispatchRejectionReason(
  value: unknown,
  seen: Set<unknown> = new Set(),
): OrchestrationV2DispatchRejectionReason | undefined {
  if (!Predicate.isObject(value) || seen.has(value)) return undefined;
  seen.add(value);
  if (value._tag === "OrchestratorThreadNotEmptyError") return "thread_not_empty";
  if (value._tag === "OrchestratorThreadNotSideChatError") return "thread_not_side_chat";
  return dispatchRejectionReason(value.cause, seen) ?? dispatchRejectionReason(value.error, seen);
}

export function userFacingDispatchErrorMessage(cause: unknown): string | undefined {
  const messages = collectErrorMessages(cause, new Set()).filter(
    (message, index, allMessages) =>
      !isGenericErrorMessage(message) && allMessages.indexOf(message) === index,
  );
  return messages.at(-1);
}
