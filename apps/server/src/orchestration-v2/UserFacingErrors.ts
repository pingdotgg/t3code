const GENERIC_ERROR_PREFIXES = [
  "Failed to dispatch orchestration V2 command",
  "Failed to dispatch orchestration command ",
  "Provider adapter failed while dispatching orchestration command ",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function textValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function messageFrom(value: unknown): string | undefined {
  if (typeof value === "string") {
    return textValue(value);
  }
  if (value instanceof Error) {
    return textValue(value.message);
  }
  if (!isRecord(value)) {
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
  if (!isRecord(value)) {
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
