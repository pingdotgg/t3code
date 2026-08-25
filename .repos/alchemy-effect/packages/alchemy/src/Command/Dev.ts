import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import * as Hash from "effect/Hash";
import * as Stream from "effect/Stream";
import { isResolved } from "../Diff.ts";
import * as ProviderLayer from "../Local/ProviderLayer.ts";
import * as RpcProvider from "../Local/RpcProvider.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import {
  CommandError,
  CommandExecutor,
  UnexpectedExit,
  type CommandProps,
} from "./Command.ts";

export interface DevProps extends CommandProps {}

export interface Dev extends Resource<
  "Command.Dev",
  DevProps,
  {
    /**
     * URL extracted from stdout/stderr. A `localhost`/IP URL (the dev
     * server's own address) is preferred over any other URL the command
     * prints; a non-local URL is only used as a fallback if no local one
     * appears. Best-effort: `undefined` if no URL appears within 5 seconds.
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
 * @resource
 *
 * @section Basic Usage
 * Pass a shell command that starts a long-lived dev server. Alchemy
 * runs it in the background and extracts the first URL it prints.
 *
 * @example Start a Vite dev server
 * ```typescript
 * const dev = yield* Dev("Frontend", {
 *   command: "npm run dev",
 * });
 * yield* Console.log(dev.url); // e.g. "http://localhost:5173"
 * ```
 *
 * @section Working Directory
 * Use `cwd` to run the command in a subdirectory — useful in
 * monorepos where each package has its own dev server.
 *
 * @example Monorepo package
 * ```typescript
 * const dev = yield* Dev("Web", {
 *   command: "npm run dev",
 *   cwd: "apps/web",
 * });
 * ```
 *
 * @section Environment Variables
 * Extra environment variables are merged on top of `process.env`.
 * Sensitive values can be wrapped in `Redacted` to keep them out
 * of logs and state files.
 *
 * @example Custom port and env
 * ```typescript
 * const dev = yield* Dev("Api", {
 *   command: "npm run dev",
 *   env: {
 *     PORT: "4000",
 *     DATABASE_URL: Redacted.make("postgres://..."),
 *   },
 * });
 * ```
 */
export const Dev = Resource<Dev>("Command.Dev");

export const DevProvider = () =>
  ProviderLayer.select({
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
  RpcProvider.effect(
    Dev,
    import.meta.resolve(
      import.meta.url.endsWith(".ts") ? "./Local.ts" : "./Local.js",
      import.meta.url,
    ),
    Effect.gen(function* () {
      const { spawn } = yield* CommandExecutor;
      const map = yield* FiberMap.make();
      const hashes = new Map<string, number>();

      const spawnAndExtractResult = Effect.fn(function* (
        props: DevProps,
        urlDeferred: Deferred.Deferred<string | undefined, CommandError>,
      ) {
        const child = yield* spawn(props);

        let buffer = "";
        // A non-local URL seen so far (docs link, error page, update notice,
        // …). Held as a fallback so that if the dev server never prints a
        // localhost/IP URL we still surface something, but a localhost URL
        // always wins if one shows up. See issue #695.
        let fallbackUrl: string | undefined;
        const deferred = yield* Deferred.make<string>();

        const mirror = (sink: "stdout" | "stderr") =>
          child[sink].pipe(
            Stream.tap((chunk) =>
              Effect.sync(() => process[sink].write(chunk)),
            ),
            Stream.decodeText,
            Stream.tap((text) =>
              Effect.sync(() => {
                if (Deferred.isDoneUnsafe(deferred)) return;
                buffer += text;
                const url = extractUrl(buffer);
                if (!url) return;
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
        yield* Effect.raceAllFirst([
          Deferred.await(deferred).pipe(
            Effect.timeoutOrElse({
              duration: "5 seconds",
              // No localhost/IP URL appeared in time — fall back to any other
              // URL we saw (or `undefined` if the process stayed silent).
              orElse: () => Effect.succeed(fallbackUrl),
            }),
          ),
          child.exitCode.pipe(
            Effect.mapError(
              (error) =>
                new CommandError({
                  command: props.command,
                  reason: error.reason,
                }),
            ),
            Effect.flatMap(
              (exitCode) =>
                new CommandError({
                  command: props.command,
                  reason: new UnexpectedExit({ exitCode, stderr: buffer }),
                }),
            ),
          ),
        ]).pipe(Deferred.into(urlDeferred));
        return yield* child.exitCode;
      }, Effect.scoped);

      return {
        list: () => Effect.succeed([]),
        diff: Effect.fn(function* ({ instanceId, news }) {
          if (!isResolved(news)) return undefined;
          const hash = Hash.structure(news);
          if (
            hashes.get(instanceId) === hash &&
            (yield* FiberMap.has(map, instanceId))
          ) {
            return { action: "noop" };
          }
          return { action: "update" };
        }),
        reconcile: Effect.fn(function* ({ instanceId, news }) {
          const hash = Hash.structure(news);
          hashes.set(instanceId, hash);
          const deferred = yield* Deferred.make<
            string | undefined,
            CommandError
          >();
          yield* FiberMap.run(
            map,
            instanceId,
            spawnAndExtractResult(news, deferred),
            { propagateInterruption: true },
          );
          return { url: yield* Deferred.await(deferred) };
        }),
        delete: Effect.fn(function* ({ instanceId }) {
          yield* FiberMap.remove(map, instanceId);
          hashes.delete(instanceId);
        }),
      };
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

// ECMA-262 ANSI/VT100 escape sequences — `Vite`, `Next`, etc. surround the
// URL with color codes that would otherwise be eaten by the URL regex.
// eslint-disable-next-line no-control-regex
const ANSI_REGEX = /\x1b\[[0-9;]*m/g;

/**
 * Extract a URL from `text`, favoring a localhost/IP URL (the dev server's
 * own address) over any other URL. Returns the first localhost/IP URL if one
 * is present, otherwise the first plain http(s) URL, otherwise `undefined`.
 * @internal
 */
export const extractUrl = (text: string) => {
  const clean = text.replaceAll(ANSI_REGEX, "");
  return clean.match(LOCAL_URL_REGEX)?.[0] ?? clean.match(URL_REGEX)?.[0];
};

const isLocalUrl = (url: string) => LOCAL_URL_REGEX.test(url);
