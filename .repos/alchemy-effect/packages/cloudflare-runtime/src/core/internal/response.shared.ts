import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { RuntimeError, SystemError } from "../RuntimeError.shared.ts";

const ErrorEnvelope = Schema.Struct({
  ok: Schema.Literal(false),
  error: RuntimeError,
});
type ErrorEnvelope = typeof ErrorEnvelope.Type;

// Shared by sync/Promise call sites (Response.json, node:http), not Effect code.
// oxlint-disable-next-line effecttsgo/schema-sync
const encodeErrorResponse = Schema.encodeSync(ErrorEnvelope);
const decodeErrorResponse = Schema.decodeUnknownResult(ErrorEnvelope);

export const makeErrorEnvelope = (error: RuntimeError) => encodeErrorResponse({ ok: false, error });

export const makeErrorResponse = (
  error: RuntimeError,
  init?: { status?: number; headers?: Record<string, string> },
): Response =>
  Response.json(makeErrorEnvelope(error), {
    status: init?.status ?? 500,
    headers: { "content-type": "application/json", ...init?.headers },
  });

export const decodeResponse = async <T>(response: Response) => {
  const text = await response.text().catch(() => "");
  let json: { ok: true; result: T } | ErrorEnvelope;
  try {
    json = JSON.parse(text);
  } catch {
    throw SystemError.make({
      subtag: "InvalidResponse",
      message: `Invalid response from server (${response.status} ${response.statusText})`,
      detail: { status: response.status, body: text },
    });
  }
  if (json.ok) {
    return json.result;
  }
  const decoded = decodeErrorResponse(json);
  if (Result.isSuccess(decoded)) {
    throw decoded.success.error;
  }
  throw SystemError.make({
    subtag: "InvalidResponse",
    message: `Invalid response from server (${response.status} ${response.statusText})`,
    detail: { status: response.status, body: text },
  });
};
