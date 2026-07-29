/**
 * CloudflaredTunnel — managed public HTTPS route for the ChatGPT connector.
 *
 * Runs `cloudflared tunnel --url http://127.0.0.1:<port>` as a scoped child
 * process and scrapes the ephemeral `https://*.trycloudflare.com` hostname
 * from its output. Quick tunnels need no Cloudflare account, which is what
 * makes this the zero-config path; the price is a hostname that changes on
 * every start, which the settings copy and docs are honest about.
 *
 * The target port is expected to be the `McpTunnelProxy`, never the main
 * server port — the tunnel makes a port public, and only the proxy makes
 * "public" mean "just /mcp".
 *
 * Failure is always soft. No cloudflared binary, no network, no URL within
 * the timeout: the tunnel reports `undefined` and the caller advertises no
 * connector, because a missing connector explains itself in the timeline
 * while a broken one fails silently on OpenAI's side.
 *
 * @module mcp/CloudflaredTunnel
 */
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

const URL_PATTERN = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/g;
const URL_SCAN_TAIL_LENGTH = 256;
const URL_WAIT_TIMEOUT = Duration.seconds(45);

/**
 * Finds the quick-tunnel hostname in cloudflared's output, skipping the
 * `api.trycloudflare.com` control-plane host that appears in the same lines.
 */
export const parseCloudflaredUrl = (text: string): string | undefined => {
  for (const match of text.matchAll(URL_PATTERN)) {
    if (!match[0].startsWith("https://api.")) return match[0];
  }
  return undefined;
};

/**
 * Keeps enough recent output to find a URL split across process stream chunks.
 * The suffix is bounded because cloudflared output is untrusted process output.
 */
export const makeCloudflaredUrlScanner = () => {
  let tail = "";

  return (chunk: string): string | undefined => {
    const url = parseCloudflaredUrl(tail + chunk);
    tail = (tail + chunk).slice(-URL_SCAN_TAIL_LENGTH);
    return url;
  };
};

export interface CloudflaredTunnelHandle {
  /** Current public base URL; `undefined` until scraped or after a crash. */
  readonly publicUrl: Effect.Effect<string | undefined>;
}

/**
 * Starts cloudflared inside the given scope and resolves once the public URL
 * is known (or the wait times out). The child process dies with the scope.
 */
export const startCloudflaredTunnel = (input: {
  readonly localPort: number;
  readonly executable?: string;
}): Effect.Effect<
  CloudflaredTunnelHandle,
  never,
  ChildProcessSpawner.ChildProcessSpawner | Scope.Scope
> =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const urlRef = yield* Ref.make<string | undefined>(undefined);
    const firstUrl = yield* Deferred.make<string | undefined>();
    const executable = input.executable?.trim() || "cloudflared";

    const child = yield* spawner.spawn(
      ChildProcess.make(executable, [
        "tunnel",
        "--no-autoupdate",
        "--url",
        `http://127.0.0.1:${input.localPort}`,
      ]),
    );

    // cloudflared prints the assigned hostname on stderr. Watch both streams
    // anyway — log routing has moved between releases.
    const scanCloudflaredOutput = makeCloudflaredUrlScanner();
    const watchOutput = child.all.pipe(
      Stream.decodeText(),
      Stream.runForEach((chunk) =>
        Effect.gen(function* () {
          const url = scanCloudflaredOutput(chunk);
          if (url !== undefined) {
            yield* Ref.set(urlRef, url);
            yield* Deferred.succeed(firstUrl, url);
          }
        }),
      ),
      // Stream end = process exit: the URL (if any) is gone with the tunnel.
      Effect.andThen(Ref.set(urlRef, undefined)),
      Effect.andThen(Deferred.succeed(firstUrl, undefined)),
      Effect.ignore,
    );
    yield* Effect.forkScoped(watchOutput);

    // Block startup only as long as it takes to learn the URL; a slow or
    // failed tunnel degrades to "no connector", not a hung provider.
    const scraped = yield* Deferred.await(firstUrl).pipe(
      Effect.timeoutOption(URL_WAIT_TIMEOUT),
      Effect.map((option) => (option._tag === "Some" ? option.value : undefined)),
    );
    if (scraped === undefined) {
      yield* Effect.logWarning(
        "cloudflared did not report a public URL; the ChatGPT connector will not be advertised. Is cloudflared installed and is the network up?",
        { localPort: input.localPort },
      );
    } else {
      yield* Effect.logInfo("cloudflared quick tunnel ready", { publicUrl: scraped });
    }

    return { publicUrl: Ref.get(urlRef) };
  }).pipe(
    Effect.catch((error) =>
      Effect.gen(function* () {
        yield* Effect.logWarning(
          "Could not start cloudflared; the ChatGPT connector will not be advertised. Install it with `brew install cloudflared`, or set a manual public HTTPS address in the ChatGPT provider settings.",
          { error: String(error) },
        );
        return {
          publicUrl: Effect.succeed(undefined),
        } satisfies CloudflaredTunnelHandle;
      }),
    ),
  );
