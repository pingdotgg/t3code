const MAX_DIAGNOSTIC_TEXT_LENGTH = 2_000;

export interface SanitizedErrorCause {
  readonly tag?: string;
  readonly name?: string;
  readonly message?: string;
  readonly detail?: string;
  readonly code?: string;
  readonly exitCode?: number;
  readonly timeoutMs?: number;
  readonly truncated?: boolean;
}

type MutableSanitizedErrorCause = {
  -readonly [Key in keyof SanitizedErrorCause]?: SanitizedErrorCause[Key];
};

function truncateDiagnosticText(value: string): {
  readonly text: string;
  readonly truncated: boolean;
} {
  if (value.length <= MAX_DIAGNOSTIC_TEXT_LENGTH) {
    return { text: value, truncated: false };
  }
  return {
    text: `${value.slice(0, MAX_DIAGNOSTIC_TEXT_LENGTH)}\n\n[truncated]`,
    truncated: true,
  };
}

function stringField(record: Record<PropertyKey, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberField(record: Record<PropertyKey, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function addTextField(
  output: MutableSanitizedErrorCause,
  key: "tag" | "name" | "message" | "detail" | "code",
  value: string | undefined,
) {
  if (!value) return;
  const truncated = truncateDiagnosticText(value);
  output[key] = truncated.text;
  if (truncated.truncated) output.truncated = true;
}

export function sanitizeErrorCause(cause: unknown): SanitizedErrorCause {
  if (typeof cause === "string") {
    const output: MutableSanitizedErrorCause = {};
    addTextField(output, "message", cause);
    return output;
  }

  if (typeof cause === "object" && cause !== null) {
    const record = cause as Record<PropertyKey, unknown>;
    const output: MutableSanitizedErrorCause = {};
    addTextField(output, "tag", stringField(record, "_tag"));
    addTextField(output, "name", cause instanceof Error ? cause.name : stringField(record, "name"));
    addTextField(
      output,
      "message",
      cause instanceof Error ? cause.message : stringField(record, "message"),
    );
    addTextField(output, "detail", stringField(record, "detail"));
    addTextField(output, "code", stringField(record, "code"));

    const exitCode = numberField(record, "exitCode");
    if (exitCode !== undefined) output.exitCode = exitCode;

    const timeoutMs = numberField(record, "timeoutMs");
    if (timeoutMs !== undefined) output.timeoutMs = timeoutMs;

    return Object.keys(output).length > 0 ? output : { tag: "Object" };
  }

  return { message: "Unknown error" };
}
