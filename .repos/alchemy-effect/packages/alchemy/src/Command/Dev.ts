import * as ConsoleService from "effect/Console";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { stripVTControlCharacters } from "node:util";
import { makeResourceOutput } from "../Util/ResourceOutput.ts";
import { makeDevLogOpener } from "../Local/DevLog.ts";
import { FQN_SEPARATOR } from "../FQN.ts";
import * as LocalProvider from "../Local/LocalProvider.ts";
import * as ProviderLayer from "../Local/ProviderLayer.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import { Stage } from "../Stage.ts";
import {
  CommandExecutor,
  UnexpectedExit,
  makeCommandError,
  type CommandProps,
} from "./Command.ts";
import { makeCommandRedactor } from "./Redaction.ts";

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
    import.meta.resolve(
      import.meta.url.endsWith(".ts") ? "./Local.ts" : "./Local.js",
      import.meta.url,
    ),
    Effect.gen(function* () {
      const { spawn } = yield* CommandExecutor;
      const stage = yield* Stage;
      const openDevLog = yield* makeDevLogOpener;
      const baseConsole = yield* ConsoleService.Console;

      return {
        // The dev process is spawned into the instance scope the helper
        // provides: it keeps running after `start` returns (readiness) and
        // is killed when the helper closes the scope on restart/delete.
        start: Effect.fn(function* ({ id, fqn, news: props, invalidate }) {
          const child = yield* spawn(props);
          const redactor = makeCommandRedactor(props.env);
          // One log file per process generation, closed with the instance
          // scope: log/{stage}/{fqn…}/{timestamp}.log (namespaces nest as dirs). Terminal lines
          // carry the resource's pnpm-style prefix; the file gets raw text.
          const devLog = yield* openDevLog(stage, ...fqn.split(FQN_SEPARATOR));
          yield* Effect.log(`[${fqn}] Logs → ${devLog.path}`);
          // Through the Console SERVICE, never a raw fd write: the process
          // that owns the terminal runs an ink renderer, and a bare write
          // to its stdout tears the animated region. The CLI's console
          // capture inserts these lines above it instead.
          const prefixed = makeResourceOutput(fqn, baseConsole);
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

          const mirror = (sink: "stdout" | "stderr") =>
            child[sink].pipe(
              Stream.decodeText,
              redactor.stream,
              Stream.tap((text) =>
                Effect.sync(() => {
                  prefixed[sink].push(text);
                  devLog.write(text);
                }),
              ),
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

          // Readiness: a URL appears (or the 5s budget elapses), unless the
          // process exits first — an exit before readiness is a failure.
          const url = yield* Effect.raceAllFirst([
            Deferred.await(deferred).pipe(
              Effect.timeoutOrElse({
                duration: "5 seconds",
                // No localhost/IP URL appeared in time — fall back to any
                // other URL we saw (or `undefined` if it stayed silent).
                orElse: () => Effect.succeed(fallbackUrl),
              }),
            ),
            child.exitCode.pipe(
              Effect.mapError((error) => makeCommandError(props, error.reason)),
              Effect.flatMap((exitCode) =>
                makeCommandError(
                  props,
                  new UnexpectedExit({ exitCode, stderr: buffer }),
                ),
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
