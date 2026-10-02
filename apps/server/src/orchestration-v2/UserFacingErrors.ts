import { PROVIDER_DISPLAY_NAMES, type ProviderDriverKind } from "@t3tools/contracts";
import * as Predicate from "effect/Predicate";

const GENERIC_ERROR_PREFIXES = [
  "Failed to dispatch orchestration V2 command",
  "Failed to dispatch orchestration command ",
  "Provider adapter failed while dispatching orchestration command ",
];

/**
 * User-facing prose for capability rejections. The internal error messages
 * keep command ids and capability codes for logs; the toast should say what
 * did not happen and why in the provider's own name.
 */
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

/** Friendly translation for command-policy rejections; undefined otherwise. */
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

export function userFacingDispatchErrorMessage(cause: unknown): string | undefined {
  const messages = collectErrorMessages(cause, new Set()).filter(
    (message, index, allMessages) =>
      !isGenericErrorMessage(message) && allMessages.indexOf(message) === index,
  );
  return messages.at(-1);
}
