import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import { OpencodeContainer } from "./opencode-container.ts";

// Matches OPENCODE_SERVER_PASSWORD=bench in contexts/opencode/Dockerfile
// (username defaults to `opencode`): base64("opencode:bench").
const AUTH = "Basic b3BlbmNvZGU6YmVuY2g=";

/**
 * Durable Object backing one opencode container instance. `boot()` blocks
 * until opencode's `/global/health` endpoint answers `{"healthy":true}` AND a
 * session can be created — the same two-request readiness probe the MicroVM
 * hosts use, so the platforms share one definition of "usable coding agent".
 * NOTE: the authoritative cold-start clock runs in the Worker AROUND the whole
 * DO call — the container layer eagerly starts the container during DO
 * construction, so a clock started here would miss part of the start.
 */
export class OpencodeObject extends Cloudflare.DurableObject<OpencodeObject>()(
  "BenchOpencodeObject",
  Effect.gen(function* () {
    const container = yield* OpencodeContainer;

    return Effect.gen(function* () {
      const { fetch } = yield* container.getTcpPort(8080);

      return {
        boot: () =>
          Effect.gen(function* () {
            const start = yield* Effect.sync(() => Date.now());
            yield* Effect.gen(function* () {
              const health = yield* fetch(
                HttpClientRequest.get("http://container/global/health").pipe(
                  HttpClientRequest.setHeader("authorization", AUTH),
                ),
              );
              const healthBody = yield* health.text;
              if (
                health.status !== 200 ||
                !healthBody.includes('"healthy":true')
              ) {
                return yield* Effect.fail(
                  new Error(
                    `opencode health ${health.status}: ${healthBody.slice(0, 120)}`,
                  ),
                );
              }
              // A real write through the app — proves the server is
              // functional, not merely listening.
              const session = yield* fetch(
                HttpClientRequest.post("http://container/session").pipe(
                  HttpClientRequest.setHeader("authorization", AUTH),
                  HttpClientRequest.bodyJsonUnsafe({}),
                ),
              );
              const sessionBody = yield* session.text;
              if (session.status !== 200 || !sessionBody.includes('"id"')) {
                return yield* Effect.fail(
                  new Error(
                    `opencode session ${session.status}: ${sessionBody.slice(0, 120)}`,
                  ),
                );
              }
            }).pipe(
              Effect.retry({
                schedule: Schedule.min([Schedule.exponential("1 second"), Schedule.spaced("5 seconds")]),
                times: 40,
              }),
            );
            const readyMs = (yield* Effect.sync(() => Date.now())) - start;
            return { readyMs };
          }),
        shutdown: () => container.destroy().pipe(Effect.ignore),
      };
    });
  }).pipe(
    Effect.provide(
      Cloudflare.Containers.layer(OpencodeContainer, {
        enableInternet: true,
      }),
    ),
  ),
) {}
