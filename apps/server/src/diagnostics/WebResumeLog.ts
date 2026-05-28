// @effect-diagnostics nodeBuiltinImport:off
import path from "node:path";

import { RotatingFileSink } from "@t3tools/shared/logging";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

export const WEB_RESUME_DIAGNOSTICS_ROUTE = "/diagnostics/web-resume";
export const WEB_RESUME_DIAGNOSTICS_LOG_PATH = path.join(
  process.cwd(),
  ".diagnostics",
  "web-resume.log",
);

const WEB_RESUME_LOG_MAX_BYTES = 5 * 1024 * 1024;
const WEB_RESUME_LOG_MAX_FILES = 1;
const WEB_RESUME_LOG_MAX_BATCH_ENTRIES = 500;
const WEB_RESUME_LOG_MAX_DATA_BYTES = 8 * 1024;

interface WebResumeLogEntry {
  readonly ts: number;
  readonly kind: string;
  readonly reason?: string;
  readonly env?: string;
  readonly data?: unknown;
}

class WebResumeLogAppendError extends Schema.TaggedErrorClass<WebResumeLogAppendError>()(
  "WebResumeLogAppendError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {}

let sink: RotatingFileSink | null = null;

function getSink(): RotatingFileSink {
  sink ??= new RotatingFileSink({
    filePath: WEB_RESUME_DIAGNOSTICS_LOG_PATH,
    maxBytes: WEB_RESUME_LOG_MAX_BYTES,
    maxFiles: WEB_RESUME_LOG_MAX_FILES,
  });
  return sink;
}

function truncateString(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : value.slice(0, maxLength);
}

function sanitizeData(value: unknown): unknown {
  if (value === undefined) {
    return undefined;
  }

  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) {
      return undefined;
    }
    if (Buffer.byteLength(serialized, "utf8") > WEB_RESUME_LOG_MAX_DATA_BYTES) {
      return { truncated: true, bytes: Buffer.byteLength(serialized, "utf8") };
    }
    return JSON.parse(serialized);
  } catch {
    return { serializationError: true };
  }
}

function normalizeEntry(value: unknown): WebResumeLogEntry | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }

  const record = value as Record<string, unknown>;
  const ts = record.ts;
  if (
    typeof ts !== "number" ||
    !Number.isFinite(ts) ||
    typeof record.kind !== "string" ||
    record.kind.length === 0
  ) {
    return null;
  }

  return {
    ts,
    kind: truncateString(record.kind, 100),
    ...(typeof record.reason === "string" ? { reason: truncateString(record.reason, 200) } : {}),
    ...(typeof record.env === "string" ? { env: truncateString(record.env, 200) } : {}),
    ...(record.data !== undefined ? { data: sanitizeData(record.data) } : {}),
  };
}

export function normalizeWebResumeLogEntries(value: unknown): ReadonlyArray<WebResumeLogEntry> {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .slice(0, WEB_RESUME_LOG_MAX_BATCH_ENTRIES)
    .map(normalizeEntry)
    .filter((entry): entry is WebResumeLogEntry => entry !== null);
}

export function appendWebResumeLogEntries(
  entries: ReadonlyArray<WebResumeLogEntry>,
): Effect.Effect<void, WebResumeLogAppendError> {
  if (entries.length === 0) {
    return Effect.void;
  }

  return Effect.try({
    try: () => {
      const lines = entries.map((entry) => `${JSON.stringify(entry)}\n`).join("");
      getSink().write(lines);
    },
    catch: (cause) =>
      new WebResumeLogAppendError({
        message: "Failed to append web resume diagnostics",
        cause,
      }),
  });
}

export const webResumeDiagnosticsRouteLayer = HttpRouter.add(
  "POST",
  WEB_RESUME_DIAGNOSTICS_ROUTE,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const body = yield* request.json.pipe(Effect.catch(() => Effect.succeed(null)));
    const entries = normalizeWebResumeLogEntries(body);
    yield* appendWebResumeLogEntries(entries).pipe(
      Effect.catch((error) =>
        Effect.logWarning("Failed to append web resume diagnostics", {
          error,
          path: WEB_RESUME_DIAGNOSTICS_LOG_PATH,
        }),
      ),
    );
    return HttpServerResponse.empty({ status: 204 });
  }),
);
