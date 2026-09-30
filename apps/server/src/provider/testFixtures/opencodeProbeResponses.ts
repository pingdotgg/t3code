/**
 * Responses recorded from `opencode serve` 1.18.32 and 2.0.18 on 2026-09-29, replayed by an
 * `HttpClient` so the version probe runs against real bytes.
 */
import * as Effect from "effect/Effect";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

interface RecordedResponse {
  readonly status: number;
  readonly contentType?: string;
  readonly body: string;
}

// Both versions serve their web UI's index page for unknown paths. Bodies are cut after the
// first lines; the classifier rejects them on content type alone.
const SPA_HTML =
  '<!doctype html>\n<html lang="en" style="background-color: var(--v2-background-bg-deep, #fafafa)">\n';

export const OPENCODE_2_RESPONSES = {
  "/api/info": {
    status: 200,
    contentType: "application/json",
    body: '{"version":"2.0.18","pid":2393556,"urls":["http://127.0.0.1:48771"],"paths":{"tmp":"/tmp/opencode"}}',
  },
  "/global/health": { status: 200, contentType: "text/html", body: SPA_HTML },
  unauthorized: {
    status: 401,
    contentType: "application/json",
    body: '{"_tag":"UnauthorizedError","message":"Authentication required"}',
  },
} satisfies Record<string, RecordedResponse>;

export const OPENCODE_1_RESPONSES = {
  "/api/info": { status: 200, contentType: "text/html", body: SPA_HTML },
  "/global/health": {
    status: 200,
    contentType: "application/json",
    body: '{"healthy":true,"version":"1.18.32"}',
  },
  // 1.x also answers a wrong password with an empty 401 on every path.
  unauthorized: { status: 401, body: "" },
} satisfies Record<string, RecordedResponse>;

/** Replays a recorded server; credentials other than `password` (none when empty) get its 401. */
export function replayOpenCodeServer(
  responses: typeof OPENCODE_1_RESPONSES | typeof OPENCODE_2_RESPONSES,
  password: string,
  requestedPaths: Array<string> = [],
) {
  const expected = password ? `Basic ${btoa(`opencode:${password}`)}` : undefined;
  return HttpClient.make((request) => {
    const path = new URL(request.url).pathname;
    requestedPaths.push(path);
    const recorded: RecordedResponse =
      (path === "/api/info" || path === "/global/health") &&
      request.headers.authorization === expected
        ? responses[path]
        : responses.unauthorized;
    return Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response(recorded.body, {
          status: recorded.status,
          headers: recorded.contentType ? { "content-type": recorded.contentType } : {},
        }),
      ),
    );
  });
}
