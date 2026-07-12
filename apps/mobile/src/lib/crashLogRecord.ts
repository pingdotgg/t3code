import { getBreadcrumbs, type Breadcrumb } from "./breadcrumbs";

export type CrashLogRecord = {
  readonly breadcrumbs: ReadonlyArray<Breadcrumb>;
  readonly capturedAt: string;
  readonly handlerInvocation: number;
  readonly isFatal: boolean;
  readonly message: string;
  readonly name: string | null;
  readonly source?: string;
  readonly stack: string | null;
};

const MAX_MESSAGE_CHARS = 8_000;
const MAX_STACK_CHARS = 48_000;

export function buildMinimalCrashRecord(
  error: unknown,
  isFatal: boolean,
  handlerInvocation: number,
): CrashLogRecord {
  return {
    breadcrumbs: [],
    capturedAt: new Date().toISOString(),
    handlerInvocation,
    isFatal,
    message: truncate(safeMessage(error), MAX_MESSAGE_CHARS),
    name: safeName(error),
    source: "error-utils",
    stack: truncateNullable(safeStack(error), MAX_STACK_CHARS),
  };
}

export function buildCrashRecord(
  error: unknown,
  isFatal: boolean,
  handlerInvocation: number,
): CrashLogRecord {
  return {
    breadcrumbs: getBreadcrumbs(),
    capturedAt: new Date().toISOString(),
    handlerInvocation,
    isFatal,
    message: truncate(safeMessage(error), MAX_MESSAGE_CHARS),
    name: safeName(error),
    source: "error-utils",
    stack: truncateNullable(safeStack(error), MAX_STACK_CHARS),
  };
}

export function shouldPersistNonFatal(error: unknown): boolean {
  return (
    error instanceof Error &&
    typeof error.stack === "string" &&
    error.stack.length > 0 &&
    error.message.length > 0
  );
}

function safeMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message.length > 0 ? error.message : error.name || "Error";
  }
  if (typeof error === "string") {
    return error;
  }
  try {
    return String(error);
  } catch {
    return "unknown-error";
  }
}

function safeName(error: unknown): string | null {
  if (error instanceof Error) {
    return error.name || null;
  }
  return null;
}

function safeStack(error: unknown): string | null {
  if (error instanceof Error && typeof error.stack === "string") {
    return error.stack;
  }
  return null;
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function truncateNullable(text: string | null, max: number): string | null {
  if (text === null) {
    return null;
  }
  return truncate(text, max);
}
