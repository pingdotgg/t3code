/**
 * `d handoff` — the CLI half of agent-driven handoff (ADR 0002).
 *
 * Runs *inside* a d-spawned agent session: the `t3:handoff` skill has the live
 * agent compose the new thread's name and summary, then invoke this command
 * with the summary on stdin. It calls back to the running server using the
 * env vars d injected at session spawn (`T3_SERVER_ORIGIN`, `T3_SERVER_TOKEN`)
 * and prints the created thread's title, id, and URL.
 *
 * ```sh
 * d handoff --name "Fix flaky auth tests" <<'HANDOFF_SUMMARY'
 * Goal: ...
 * HANDOFF_SUMMARY
 * ```
 *
 * @module cli/handoff
 */
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Command, Flag } from "effect/unstable/cli";
import { FetchHttpClient, HttpBody, HttpClient } from "effect/unstable/http";

import {
  T3_SERVER_ORIGIN_ENV,
  T3_SERVER_TOKEN_ENV,
  HANDOFF_HTTP_PATH,
  HandoffResponse,
} from "../handoff/protocol.ts";

export class HandoffCliError extends Schema.TaggedErrorClass<HandoffCliError>()("HandoffCliError", {
  message: Schema.String,
}) {}

const optionalEnv = (name: string) =>
  Config.string(name).pipe(Config.option, Config.map(Option.getOrUndefined));

const readStdin = Effect.tryPromise({
  try: async () => {
    const chunks: Array<Buffer> = [];
    for await (const chunk of process.stdin) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks).toString("utf8");
  },
  catch: () => new HandoffCliError({ message: "Failed to read the summary from stdin." }),
});

const decodeHandoffResponse = Schema.decodeUnknownEffect(HandoffResponse);

const readErrorMessage = (body: unknown): string | undefined => {
  if (body && typeof body === "object" && "message" in body) {
    const message = (body as { message?: unknown }).message;
    return typeof message === "string" ? message : undefined;
  }
  return undefined;
};

export const handoffCommand = Command.make("handoff", {
  name: Flag.string("name").pipe(
    Flag.withDescription("Name for the new thread; becomes its title."),
  ),
}).pipe(
  Command.withDescription(
    "Hand off work to a new thread (run inside a d-managed agent session; summary on stdin).",
  ),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const origin = yield* optionalEnv(T3_SERVER_ORIGIN_ENV);
      const token = yield* optionalEnv(T3_SERVER_TOKEN_ENV);
      if (!origin || !token) {
        return yield* new HandoffCliError({
          message:
            `Missing ${T3_SERVER_ORIGIN_ENV}/${T3_SERVER_TOKEN_ENV} — ` +
            "`d handoff` only works inside a d-managed agent session.",
        });
      }

      const summary = (yield* readStdin).trim();
      if (summary.length === 0) {
        return yield* new HandoffCliError({
          message: "Provide the handoff summary on stdin (e.g. via a heredoc).",
        });
      }
      const name = flags.name.trim();
      if (name.length === 0) {
        return yield* new HandoffCliError({ message: "--name must not be empty." });
      }

      const httpClient = yield* HttpClient.HttpClient;
      const response = yield* httpClient
        .post(`${origin}${HANDOFF_HTTP_PATH}`, {
          headers: {
            authorization: `Bearer ${token}`,
          },
          body: HttpBody.jsonUnsafe({ name, summary }),
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new HandoffCliError({
                message: `Could not reach the d server at ${origin}: ${String(cause)}`,
              }),
          ),
        );

      const body: unknown = yield* response.json.pipe(
        Effect.mapError(
          () =>
            new HandoffCliError({
              message: `The d server responded with an unreadable body (HTTP ${response.status}).`,
            }),
        ),
      );

      if (response.status < 200 || response.status >= 300) {
        return yield* new HandoffCliError({
          message: readErrorMessage(body) ?? `Handoff failed (HTTP ${response.status}).`,
        });
      }

      const result = yield* decodeHandoffResponse(body).pipe(
        Effect.mapError(
          () =>
            new HandoffCliError({
              message: "The d server returned an unexpected handoff response.",
            }),
        ),
      );

      yield* Console.log(
        [
          `Handed off to "${result.title}"`,
          `Thread: ${result.threadId}`,
          `URL: ${origin}/${result.environmentId}/${result.threadId}`,
        ].join("\n"),
      );
    }).pipe(Effect.provide(FetchHttpClient.layer)),
  ),
);
