import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

const EXIT_MARKER = "__EXIT__:";

/**
 * The session's MicroVM coordinates: its endpoint host and the already-resolved
 * auth header map (from `AWS.Lambda.microvmAuthHeaders`). The DO speaks only
 * the VM's data plane — it never touches AWS credentials, so these plain
 * strings are all it needs.
 */
export interface MicrovmCoords {
  readonly endpoint: string;
  readonly headers: Record<string, string>;
}

/**
 * One terminal session. The hosting Worker provisions the session's MicroVM
 * (assume-role control plane) and hands the coordinates here via the `init`
 * RPC; the same VM is reused for every command in the session (no re-boot per
 * command).
 *
 * Each command received on the WebSocket is POSTed to the VM's streaming
 * `/exec` route; the combined stdout/stderr is forwarded back to the browser
 * chunk-by-chunk as the process produces it.
 */
export default class ShellSession extends Cloudflare.DurableObject<ShellSession>()(
  "ShellSession",
  Effect.gen(function* () {
    // The session's VM coordinates, set by the `init` RPC and reused for every
    // command in the session. The closure copy is just a cache: workerd's
    // hibernatable WebSockets SURVIVE DO eviction, so an idle session's next
    // message wakes a fresh instance (empty closure) on the SAME socket — the
    // browser never reconnects. The authoritative copy lives in DO storage and
    // is rehydrated lazily.
    let coords: MicrovmCoords | undefined;

    return Effect.gen(function* () {
      const send = (socket: Cloudflare.WebSocket, text: string) =>
        socket.send(text).pipe(Effect.ignore);

      const loadCoords = Effect.gen(function* () {
        if (coords) return coords;
        const state = yield* Cloudflare.DurableObjectState;
        coords = yield* state.storage.get<MicrovmCoords>("coords");
        return coords;
      });

      const runCommand = (socket: Cloudflare.WebSocket, command: string) =>
        Effect.gen(function* () {
          const current = yield* loadCoords;
          if (!current) {
            yield* send(socket, "[session has no microvm]\n");
            return;
          }
          const { endpoint, headers } = current;
          const client = yield* HttpClient.HttpClient;
          const request = HttpClientRequest.post(
            `https://${endpoint}/exec`,
          ).pipe(
            HttpClientRequest.setHeaders(headers),
            HttpClientRequest.bodyJsonUnsafe({ command }),
          );

          // Render like a real shell: forward output verbatim, swallow the
          // VM's `\n__EXIT__:<code>` trailer (including the separator newline
          // the server adds before it), and only make sure the next prompt
          // starts on a fresh line when the command's output didn't end with
          // one — no exit-status chatter.
          let endedWithNewline = true;
          yield* HttpClientResponse.stream(client.execute(request)).pipe(
            Stream.decodeText(),
            Stream.runForEach((chunk) =>
              Effect.gen(function* () {
                const marker = chunk.indexOf(EXIT_MARKER);
                if (marker === -1) {
                  if (chunk) {
                    endedWithNewline = chunk.endsWith("\n");
                    yield* send(socket, chunk);
                  }
                  return;
                }
                let before = chunk.slice(0, marker);
                if (before.endsWith("\n")) {
                  before = before.slice(0, -1);
                }
                if (before) {
                  endedWithNewline = before.endsWith("\n");
                  yield* send(socket, before);
                }
              }),
            ),
          );
          if (!endedWithNewline) {
            yield* send(socket, "\n");
          }
        }).pipe(
          Effect.catch((error) => send(socket, `[error] ${String(error)}\n`)),
          Effect.provide(FetchHttpClient.layer),
        );

      return {
        /** Pin this session to a provisioned MicroVM (called by the Worker). */
        init: (next: MicrovmCoords) =>
          Effect.gen(function* () {
            coords = next;
            // Persist so a hibernation wake (same socket, fresh instance)
            // finds its VM again.
            const state = yield* Cloudflare.DurableObjectState;
            yield* state.storage.put("coords", next);
          }),
        fetch: Effect.gen(function* () {
          const [response, socket] = yield* Cloudflare.upgrade();
          yield* send(
            socket,
            "connected to microvm — type a command and press enter\n",
          );
          return response;
        }),
        webSocketMessage: Effect.fn(function* (
          socket: Cloudflare.WebSocket,
          message: string | ArrayBuffer,
        ) {
          const command =
            typeof message === "string"
              ? message
              : new TextDecoder().decode(message);
          if (!command.trim()) return;
          yield* runCommand(socket, command.trim());
        }),
        webSocketClose: Effect.fn(function* (
          socket: Cloudflare.WebSocket,
          code: number,
          reason: string,
        ) {
          yield* socket.close(code, reason).pipe(Effect.ignore);
        }),
      };
    });
  }),
) {}
