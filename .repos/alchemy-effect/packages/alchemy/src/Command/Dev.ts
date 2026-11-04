import * as NodeNet from "node:net";
import { stripVTControlCharacters } from "node:util";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import { SystemError } from "effect/PlatformError";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as LocalProvider from "../Local/LocalProvider.ts";
import * as ProviderLayer from "../Local/ProviderLayer.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import { moduleExtension } from "../Util/Node.ts";
import { makeResourceOutput } from "../Util/ResourceOutput.ts";
import { CommandExecutor, UnexpectedExit, makeCommandError, type CommandProps } from "./Command.ts";
import { makeCommandRedactor } from "./Redaction.ts";

export interface DevProps extends CommandProps {
  /**
   * Make the URL required: the resource is ready only once the command
   * prints a URL, however long that takes, and fails if the command exits
   * first. Without it, the resource waits 5 seconds and settles with
   * `url: undefined` when no URL appears.
   *
   * A localhost/IP URL is still preferred: when the first URL printed is
   * another one, the resource waits up to 5 seconds more for a local one
   * before settling with it.
   *
   * @default false
   */
  waitForUrl?: boolean;
  /**
   * The port the command listens on. Alchemy sets `PORT` to it, over any
   * `env.PORT`, and the resource is ready once the port accepts a
   * connection, however long that takes. Output isn't scanned for a URL,
   * so `waitForUrl` has no effect: `url` is `http://localhost:<port>`.
   *
   * The resource fails if the command exits before the port opens, or if
   * another process already listens on the port when the command starts.
   */
  port?: number;
}

export interface Dev extends Resource<
  "Command.Dev",
  DevProps,
  {
    /**
     * URL extracted from stdout/stderr. A `localhost`/IP URL (the dev
     * server's own address) is preferred over any other URL the command
     * prints; a non-local URL is only used as a fallback if no local one
     * appears. Best-effort: `undefined` if no URL appears within 5 seconds,
     * unless `waitForUrl` is set, which waits until one does. With `port`,
     * it is `http://localhost:<port>`.
     */
    url: string | undefined;
  }
> {}

/**
 * A long-lived shell process scoped to a stack instance, started during
 * `alchemy dev` and restarted when its inputs change. During `alchemy deploy`
 * this is a no-op — `Dev` resources only run in dev mode.
 *
 * The child process runs inside the dev sidecar (see `Command/Local.ts`) so it
 * survives user-code HMR — Alchemy's user process can restart without killing
 * your `npm run dev` server. Its stdout/stderr are mirrored to the terminal
 * (preserving colored output) and scanned for an `http(s)://…` URL, favoring
 * a `localhost`/IP URL (the dev server's own address) over any unrelated URL
 * the command prints first. The result is exposed as the `url` output
 * attribute — useful for surfacing a dev server's local URL back out to
 * whatever resource declared this `Dev`.
 *
 *
 * ### Basic Usage
 * Pass a shell command that starts a long-lived dev server. Alchemy
 * runs it in the background and extracts the first URL it prints.
 *
 * **Example:** Start a Vite dev server
 * ```typescript
 * const dev = yield* Dev("Frontend", {
 *   command: "npm run dev",
 * });
 * yield* Console.log(dev.url); // e.g. "http://localhost:5173"
 * ```
 *
 * ### Requiring a URL
 * By default the resource waits 5 seconds for a URL and settles with
 * `url: undefined` if none appears. Set `waitForUrl` when downstream
 * resources depend on the URL: the resource is ready only once the
 * command prints one, however long the server takes to start, and fails
 * if the command exits first.
 *
 * **Example:** Wait for a slow server's URL
 * ```typescript
 * const engine = yield* Dev("Engine", {
 *   command: "rivet-engine start",
 *   waitForUrl: true,
 * });
 * ```
 *
 * ### Known Port
 * When you choose the port, pass it as `port`: Alchemy sets `PORT` to it
 * and the resource is ready once the port accepts a connection, with no
 * output scanning. This suits servers that print no URL, and wrappers
 * that route the port elsewhere.
 *
 * **Example:** Serve on port 4000
 * ```typescript
 * const api = yield* Dev("Api", {
 *   command: "node server.ts",
 *   port: 4000,
 * });
 * yield* Console.log(api.url); // "http://localhost:4000"
 * ```
 *
 * ### Working Directory
 * Use `cwd` to run the command in a subdirectory — useful in
 * monorepos where each package has its own dev server.
 *
 * **Example:** Monorepo package
 * ```typescript
 * const dev = yield* Dev("Web", {
 *   command: "npm run dev",
 *   cwd: "apps/web",
 * });
 * ```
 *
 * ### Environment Variables
 * Extra environment variables are merged on top of `process.env`.
 * Sensitive values can be wrapped in `Redacted` to keep them out
 * of logs and state files.
 *
 * **Example:** Custom port and env
 * ```typescript
 * const dev = yield* Dev("Api", {
 *   command: "npm run dev",
 *   env: {
 *     PORT: "4000",
 *     DATABASE_URL: Redacted.make("postgres://..."),
 *   },
 * });
 * ```
 *
 * @resource
 */
export const Dev = Resource<Dev>("Command.Dev");

export const DevProvider = () =>
  ProviderLayer.dual(Dev, {
    live: DevProviderLive,
    local: DevProviderLocal,
  });

export const DevProviderLive = () =>
  Provider.succeed(Dev, {
    list: () => Effect.succeed([]),
    diff: () => Effect.succeed({ action: "noop" }),
    reconcile: () => Effect.succeed({ url: undefined }),
    delete: () => Effect.void,
  });

export const DevProviderLocal = () =>
  LocalProvider.make(
    Dev,
    import.meta.resolve(`./Local${moduleExtension(import.meta.url)}`, import.meta.url),
    Effect.gen(function* () {
      const { spawn } = yield* CommandExecutor;

      return {
        // The dev process is spawned into the instance scope the helper
        // provides: it keeps running after `start` returns (readiness) and
        // is killed when the helper closes the scope on restart/delete.
        start: Effect.fn(function* ({ fqn, news: props, invalidate }) {
          const { port } = props;
          // A restart has already killed the previous process group, so a
          // listener now is someone else's (an orphaned server, say), and
          // the readiness probe below would mistake it for this command.
          if (port !== undefined && (yield* isListening(port))) {
            return yield* makeCommandError(
              props,
              new SystemError({
                _tag: "Busy",
                module: "Command",
                method: "Dev",
                pathOrDescriptor: port,
                description: "another process already listens on this port",
              }),
            );
          }
          const child = yield* spawn(
            port === undefined ? props : { ...props, env: { ...props.env, PORT: `${port}` } },
          );
          const redactor = makeCommandRedactor(props.env);
          // Through the logger, never a raw fd write: the process that owns
          // the terminal renders the records and writes them to the run log
          // (and a bare write to its stdout would tear the animated region).
          const prefixed = yield* makeResourceOutput(fqn);
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              prefixed.stdout.flush();
              prefixed.stderr.flush();
            }),
          );

          let buffer = "";
          // A non-local URL seen so far (docs link, error page, update notice,
          // …). Held as a fallback so that if the dev server never prints a
          // localhost/IP URL we still surface something, but a localhost URL
          // always wins if one shows up. See issue #695.
          let fallbackUrl: string | undefined;
          const deferred = yield* Deferred.make<string>();
          // Done when the first URL of any kind appears.
          const anyUrl = yield* Deferred.make<void>();

          const mirror = (sink: "stdout" | "stderr") =>
            child[sink].pipe(
              Stream.decodeText,
              redactor.stream,
              Stream.tap((text) => Effect.sync(() => prefixed[sink].push(text))),
              Stream.tap((text) =>
                Effect.sync(() => {
                  if (Deferred.isDoneUnsafe(deferred)) return;
                  buffer += text;
                  const url = extractUrl(buffer);
                  if (!url) return;
                  Deferred.doneUnsafe(anyUrl, Effect.void);
                  if (isLocalUrl(url)) {
                    // The dev server's own address — resolve immediately.
                    Deferred.doneUnsafe(deferred, Effect.succeed(url));
                  } else {
                    // Keep scanning: a localhost/IP URL may still appear.
                    fallbackUrl = url;
                  }
                }),
              ),
              Stream.runDrain,
              Effect.forkScoped,
            );

          yield* mirror("stdout");
          yield* mirror("stderr");

          // Readiness: a localhost/IP URL appears, or 5 seconds pass and we
          // settle with any other URL we saw (`undefined` with none). With
          // `waitForUrl`, those 5 seconds start only once some URL appears,
          // so the URL is required and there is no deadline: the only other
          // way out is the process exiting, which is a failure. With `port`,
          // readiness is the port opening instead, again with no deadline.
          const awaitLocalUrl = Deferred.await(deferred).pipe(
            Effect.timeoutOrElse({
              duration: "5 seconds",
              orElse: () => Effect.succeed(fallbackUrl),
            }),
          );
          const url = yield* Effect.raceAllFirst([
            port !== undefined
              ? isListening(port).pipe(
                  Effect.repeat({
                    schedule: Schedule.spaced("100 millis"),
                    until: (listening) => listening,
                  }),
                  Effect.as(`http://localhost:${port}`),
                )
              : props.waitForUrl
                ? Deferred.await(anyUrl).pipe(Effect.andThen(awaitLocalUrl))
                : awaitLocalUrl,
            child.exitCode.pipe(
              Effect.mapError((error) => makeCommandError(props, error.reason)),
              Effect.flatMap((exitCode) =>
                makeCommandError(props, new UnexpectedExit({ exitCode, stderr: buffer })),
              ),
            ),
          ]);

          // The process may die on its own after readiness (crash, manual
          // kill). Drop it from the running registry so the next plan
          // reports `update` and restarts it.
          yield* child.exitCode.pipe(
            Effect.exit,
            Effect.flatMap(() => invalidate),
            Effect.forkScoped,
          );

          return { url };
        }),
      } satisfies LocalProvider.LocalProviderSpec<Dev>;
    }),
  );

// Matches an http(s) URL whose host is `localhost`, an IPv4 address, or a
// bracketed IPv6 address — i.e. the shape a dev server prints for its own
// local address. Preferred over any other URL a command might print first
// (docs links, error pages, update notices). See issue #695.
const LOCAL_URL_REGEX =
  /https?:\/\/(?:localhost|\[[0-9a-fA-F:]+\]|(?:\d{1,3}\.){3}\d{1,3})(?::\d+)?[^\s)\],"'`]*/;

// Matches the first plain http(s) URL. Stops at whitespace and at a small
// set of punctuation typically used to wrap URLs in log output.
const URL_REGEX = /https?:\/\/[^\s)\],"'`]+/;

/**
 * Extract a URL from `text`, favoring a localhost/IP URL (the dev server's
 * own address) over any other URL. Returns the first localhost/IP URL if one
 * is present, otherwise the first plain http(s) URL, otherwise `undefined`.
 * `Vite`, `Next`, etc. surround the URL with ANSI color codes that would
 * otherwise be eaten by the URL regex, so strip them first.
 * @internal
 */
export const extractUrl = (text: string) => {
  const clean = stripVTControlCharacters(text);
  const url = clean.match(LOCAL_URL_REGEX)?.[0] ?? clean.match(URL_REGEX)?.[0];
  // Some dev servers print their *bind* address (Nuxt: `http://0.0.0.0:3000`),
  // which is not a connectable host. Normalize the unspecified address to
  // `localhost` so consumers of `url` — browser links, Router dev routing,
  // the emulated CloudFront edge dialing the origin — can actually reach it.
  return url?.replace(
    /^(https?:\/\/)(?:0\.0\.0\.0|\[::\]|\[0+:0+:0+:0+:0+:0+:0+:0+\])(?=[:/]|$)/,
    "$1localhost",
  );
};

const isLocalUrl = (url: string) => LOCAL_URL_REGEX.test(url);

// Whether a TCP connection to `port` succeeds on either loopback address:
// a server bound to `localhost` may listen on only one of them.
const isListening = (port: number) =>
  Effect.all([connects("127.0.0.1", port), connects("::1", port)], {
    concurrency: "unbounded",
  }).pipe(Effect.map(([ipv4, ipv6]) => ipv4 || ipv6));

const connects = (host: string, port: number) =>
  Effect.callback<boolean>((resume) => {
    const socket = NodeNet.connect({ host, port });
    socket.once("connect", () => {
      socket.destroy();
      resume(Effect.succeed(true));
    });
    socket.once("error", () => resume(Effect.succeed(false)));
    return Effect.sync(() => socket.destroy());
  });
