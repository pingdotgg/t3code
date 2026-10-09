/**
 * Responses recorded from `opencode serve` 1.18.32 and 2.0.18 on 2026-09-29, replayed by an
 * `HttpClient` so the version probe runs against real bytes.
 */
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

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

/**
 * A 2.0.18 server's command and skill lists for a directory with one command
 * (`.opencode/command/bee.md`) and one skill (`.opencode/skills/plum`), live on
 * 2026-09-29. Skill contents are cut; machine-wide skills are dropped.
 */
export const OPENCODE_2_WORKSPACE_RESPONSES = {
  "/api/command": {
    status: 200,
    contentType: "application/json",
    body: '{"location":{"directory":"/work"},"data":[{"name":"init","description":"guided AGENTS.md setup"},{"name":"review","description":"review changes [commit|branch|pr], defaults to uncommitted"},{"name":"bee","description":"B command"}]}',
  },
  "/api/skill": {
    status: 200,
    contentType: "application/json",
    body: '{"location":{"directory":"/work"},"data":[{"id":"opencode","name":"OpenCode","description":"Use this skill for any question about OpenCode itself.","path":"/builtin/opencode.md","content":"# OpenCode"},{"id":"report","name":"Report","description":"Use when the user wants to report an opencode issue or bug.","path":"/builtin/report.md","content":"<!-- Built-in skill. -->"},{"id":"plum","name":"plum","description":"plum skill","path":"/work/.opencode/skills/plum/SKILL.md","content":"Say PLUM."}]}',
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
  responses:
    | typeof OPENCODE_1_RESPONSES
    | typeof OPENCODE_2_RESPONSES
    | (typeof OPENCODE_2_RESPONSES & typeof OPENCODE_2_WORKSPACE_RESPONSES),
  password: string,
  requestedPaths: Array<string> = [],
) {
  const answers: Record<string, RecordedResponse | undefined> = responses;
  // Both versions decode Basic credentials as UTF-8 (checked live with `pässwörd` and `pass€word`).
  const expected = password
    ? `Basic ${Buffer.from(`opencode:${password}`, "utf8").toString("base64")}`
    : undefined;
  return HttpClient.make((request) => {
    const path = new URL(request.url).pathname;
    requestedPaths.push(path);
    const recorded: RecordedResponse =
      request.headers.authorization === expected
        ? (answers[path] ?? responses.unauthorized)
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
