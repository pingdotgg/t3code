/**
 * The capability to talk to the human driving this process.
 *
 * One contract, two renderers:
 *
 * - {@link layerSigil} — the interactive Sigil renderer: live rows,
 *   prompts as real screens, full-screen sessions.
 * - {@link layerNonInteractive} — append-only plain output for CI, piped
 *   output, the Alchemist API and tests. Views print once, every prompt,
 *   screen and session fails with the typed {@link NonInteractiveTerminal}.
 *
 * {@link layer} picks between them from the terminal's capabilities, so
 * callers never branch on the renderer themselves.
 *
 * Child processes (the RPC sidecar, spawned dev children) deliberately do
 * NOT provide this service at all — interaction capability is structural,
 * not configured. Code that might need a human declares it; a process that
 * cannot reach one simply doesn't have the service in its graph.
 */
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { ChildProcess } from "effect/process";
import type { ChildProcessSpawner } from "effect/process/ChildProcessSpawner";
import type * as Scope from "effect/Scope";
import type { ReactNode } from "react";
import { UserFacingError } from "./UserFacingError.ts";
import { ANSI_DIM, ANSI_RESET, ansiFg, colorsEnabled, unicodeEnabled } from "./Util/Terminal.ts";
import { glyphsFor, statusColor, type StatusVariant } from "./Util/Theme.ts";

/** The user dismissed the active terminal interaction. */
export class TerminalCancelled extends Data.TaggedError("TerminalCancelled") {}

/** An interactive operation was requested without an interactive terminal. */
export class NonInteractiveTerminal extends Data.TaggedError("NonInteractiveTerminal")<{
  readonly operation: string;
  readonly message: string;
}> {
  readonly [UserFacingError] = true;
}

/** The platform's browser launcher exited unsuccessfully. */
export class BrowserOpenFailed extends Data.TaggedError("BrowserOpenFailed")<{
  readonly command: string;
  readonly exitCode: number;
}> {}

export type InteractionError = TerminalCancelled | NonInteractiveTerminal;

export interface MessageOptions {
  readonly message: string;
  readonly detail?: string;
}

export interface TextInputOptions {
  readonly message: string;
  /** Secondary guidance rendered beneath the field in muted text. */
  readonly description?: string;
  /** Place the editable field beside the message or beneath it. @default "inline" */
  readonly layout?: "inline" | "stacked";
  readonly placeholder?: string;
  readonly initialValue?: string;
  readonly defaultValue?: string;
  readonly validate?: (value: string) => string | Error | undefined;
}

export interface PasswordInputOptions extends Omit<
  TextInputOptions,
  "initialValue" | "defaultValue"
> {}

export interface ConfirmOptions {
  readonly message: string;
  readonly initialValue?: boolean;
  readonly confirmLabel?: string;
  readonly cancelLabel?: string;
}

export interface Choice<Value> {
  readonly value: Value;
  readonly label: string;
  /** Optional section heading shared by adjacent choices. */
  readonly group?: string;
  /** Indent the entire rendered row, including its selection indicator. */
  readonly indent?: number;
  /** Keep this row visible as the heading for following rows while scrolling. */
  readonly sticky?: boolean;
  /** Visually distinguish structural rows from ordinary choices. */
  readonly tone?: "info";
  readonly description?: string;
  readonly disabled?: boolean | string;
}

export interface SelectOptions<Value> {
  readonly message: string;
  readonly options: ReadonlyArray<Choice<Value>>;
  readonly initialValue?: Value;
  readonly visibleCount?: number;
  /** Allow typing to filter choices by label and description. */
  readonly searchable?: boolean;
  /** Place descriptions beside labels instead of on a second line. */
  readonly descriptionPlacement?: "below" | "inline";
}

export interface MultiSelectOptions<Value> extends Omit<SelectOptions<Value>, "initialValue"> {
  readonly initialValues?: ReadonlyArray<Value>;
  readonly required?: boolean;
}

export interface BrowserLoginOptions<A, E, R, E2 = never, R2 = never> {
  /** Display name, e.g. `"Railway"`; titles the login. */
  readonly provider: string;
  /** The page the user logs in on. Opened in their browser for them. */
  readonly url: string;
  /** Short code the user confirms on the login page (device flows). */
  readonly code?: string;
  /** @default "waiting for browser authorization (up to 5 minutes)…" */
  readonly waitingLabel?: string;
  /** Completes the login: a token poll, a CLI process, an OAuth callback. */
  readonly waitFor: Effect.Effect<A, E, R>;
  /** Let the user paste a code instead, exchanged for the same result. */
  readonly manualCode?: {
    readonly label?: string;
    readonly placeholder?: string;
    readonly validate?: (value: string) => string | Error | undefined;
    readonly exchange: (code: string) => Effect.Effect<A, E2, R2>;
  };
}

export interface ProgressOptions {
  readonly label: string;
  readonly detail?: string;
  /** Terminal window title while this progress view is active. */
  readonly title?: string;
  /** Animate the leading status glyph. @default true */
  readonly spinning?: boolean;
}

/** A composable layout. Views are inert; only a renderer draws them. */
export type View = ReactNode;

/** What the terminal behind this process can do. */
export interface TerminalCapabilities {
  /** Whether this process has usable terminal input for prompts and sessions. */
  readonly input: boolean;
  readonly columns: number;
  readonly rows: number;
  readonly colors: boolean;
  readonly unicode: boolean;
  /** Whether full-screen sessions may use the terminal's alternate buffer. */
  readonly alternateScreen: boolean;
}

export interface ScreenController<Value> {
  readonly submit: (value: Value, summary?: View) => void;
  readonly cancel: () => void;
}

/**
 * An interactive scene. The scene owns its local component state while the
 * renderer owns input streams, serialization, rendering and teardown. Every
 * prompt is a screen; {@link Interaction} `prompt.screen` runs any other.
 */
export interface Screen<Value> {
  readonly name: string;
  readonly render: (controller: ScreenController<Value>) => View;
}

export const Screen = {
  make: <Value>(
    name: string,
    render: (controller: ScreenController<Value>) => View,
  ): Screen<Value> => ({ name, render }),
};

/**
 * Handle for a progress row. Acquired within a `Scope`: the enclosing
 * scope's close is a release backstop, so an interrupted fiber can never leave
 * an orphaned row pinning the renderer. Settling early via `succeed`/`fail`/
 * `close` is the normal path; every settle operation is idempotent.
 */
export interface ProgressHandle {
  readonly update: (options: ProgressOptions) => Effect.Effect<void>;
  readonly succeed: (message?: string) => Effect.Effect<void>;
  readonly fail: (message?: string) => Effect.Effect<void>;
  readonly close: Effect.Effect<void>;
}

/**
 * A mounted live view. The view itself is immutable — dynamic content flows
 * through a caller-owned store that its component subscribes to — so the
 * handle only controls the block's lifetime. Scope-bound the same way as
 * {@link ProgressHandle}; `close` settles early and is idempotent.
 */
export interface LiveViewHandle {
  readonly close: Effect.Effect<void>;
}

export interface LiveViewOptions {
  /** Place a session shell/header before completed prompt output. */
  readonly placement?: "beforeTranscript" | "afterTranscript";
  /** Commit the final view to the static transcript when it closes. */
  readonly persistOnClose?: boolean;
}

export interface SessionOptions {
  /** Take over the terminal's alternate screen buffer when supported. */
  readonly alternate?: boolean;
}

/**
 * The capability to ask or tell the human driving this process. Provided
 * by {@link layer}; never provided in child processes.
 */
export class Interaction extends Context.Service<
  Interaction,
  {
    readonly terminal: TerminalCapabilities;

    readonly output: {
      /** Append a completed layout to terminal scrollback/output. */
      readonly print: (view: View) => Effect.Effect<void>;
      readonly info: (message: string | MessageOptions) => Effect.Effect<void>;
      readonly success: (message: string | MessageOptions) => Effect.Effect<void>;
      readonly warning: (message: string | MessageOptions) => Effect.Effect<void>;
      readonly error: (message: string | MessageOptions) => Effect.Effect<void>;
    };

    readonly prompt: {
      readonly text: (options: TextInputOptions) => Effect.Effect<string, InteractionError>;
      readonly password: (options: PasswordInputOptions) => Effect.Effect<string, InteractionError>;
      readonly confirm: (options: ConfirmOptions) => Effect.Effect<boolean, InteractionError>;
      readonly select: <Value>(
        options: SelectOptions<Value>,
      ) => Effect.Effect<Value, InteractionError>;
      readonly multiSelect: <Value>(
        options: MultiSelectOptions<Value>,
      ) => Effect.Effect<ReadonlyArray<Value>, InteractionError>;
      /** Run an arbitrary interactive screen. */
      readonly screen: <Value>(screen: Screen<Value>) => Effect.Effect<Value, InteractionError>;
    };

    /**
     * Log the user in through their browser: open `url`, show it (and the
     * device code), and wait for `waitFor`. Fails with `TerminalCancelled`
     * when the user dismisses the login.
     */
    readonly browserLogin: <A, E, R, E2 = never, R2 = never>(
      options: BrowserLoginOptions<A, E, R, E2, R2>,
    ) => Effect.Effect<A, E | E2 | InteractionError, R | R2 | ChildProcessSpawner>;

    /**
     * Mount a live layout while the scope is open. Without an interactive
     * renderer the view prints once.
     */
    readonly live: (
      view: View,
      options?: LiveViewOptions,
    ) => Effect.Effect<LiveViewHandle, never, Scope.Scope>;

    /** Add a mutable progress row, settled through its handle. */
    readonly progress: (
      options: ProgressOptions,
    ) => Effect.Effect<ProgressHandle, never, Scope.Scope>;

    /** Run work behind a progress row and collapse it to a final status line. */
    readonly task: <A, E, R>(
      options: ProgressOptions,
      effect: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E, R>;

    /**
     * Keep one renderer alive while an Effect drives screens and prompts. A
     * nested session reuses the outer renderer and clears the prompts it
     * showed when it settles.
     */
    readonly session: <A, E, R>(
      effect: Effect.Effect<A, E, R>,
      options?: SessionOptions,
    ) => Effect.Effect<A, E | NonInteractiveTerminal, R>;
  }
>()("Alchemy::Interaction") {}

// Top-level forms of the service's messages and prompts. Each acquires
// `Interaction` when it runs, not when it's built, so a provider can hold
// one in a value without capturing whichever service was ambient then.

export const print = (view: View) => Effect.flatMap(Interaction, (i) => i.output.print(view));
export const info = (message: string | MessageOptions) =>
  Effect.flatMap(Interaction, (i) => i.output.info(message));
export const success = (message: string | MessageOptions) =>
  Effect.flatMap(Interaction, (i) => i.output.success(message));
export const warning = (message: string | MessageOptions) =>
  Effect.flatMap(Interaction, (i) => i.output.warning(message));
export const error = (message: string | MessageOptions) =>
  Effect.flatMap(Interaction, (i) => i.output.error(message));

export const text = (options: TextInputOptions) =>
  Effect.flatMap(Interaction, (i) => i.prompt.text(options));
export const password = (options: PasswordInputOptions) =>
  Effect.flatMap(Interaction, (i) => i.prompt.password(options));
export const confirm = (options: ConfirmOptions) =>
  Effect.flatMap(Interaction, (i) => i.prompt.confirm(options));
export const select = <Value>(options: SelectOptions<Value>) =>
  Effect.flatMap(Interaction, (i) => i.prompt.select(options));
export const multiSelect = <Value>(options: MultiSelectOptions<Value>) =>
  Effect.flatMap(Interaction, (i) => i.prompt.multiSelect(options));
export const browserLogin = <A, E, R, E2 = never, R2 = never>(
  options: BrowserLoginOptions<A, E, R, E2, R2>,
) => Effect.flatMap(Interaction, (i) => i.browserLogin(options));
export const screen = <Value>(scene: Screen<Value>) =>
  Effect.flatMap(Interaction, (i) => i.prompt.screen(scene));

/**
 * `task` for any renderer: a scoped progress row settled by the effect's
 * exit. Interruption (Ctrl+C) is not a failure — the row is dropped instead
 * of painted as an error.
 */
export const taskFromProgress =
  (progress: Interaction["Service"]["progress"]): Interaction["Service"]["task"] =>
  (options, effect) =>
    Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* progress(options);
        return yield* effect.pipe(
          Effect.onExit((exit) =>
            Exit.isSuccess(exit)
              ? handle.succeed()
              : Cause.hasInterruptsOnly(exit.cause)
                ? handle.close
                : handle.fail(),
          ),
        );
      }),
    );

/**
 * Open a URL in the platform's default browser without invoking a shell.
 *
 * Fails with {@link BrowserOpenFailed} when the launcher exits non-zero (e.g.
 * `xdg-open` with no handler installed). Some `xdg-open` configurations block
 * until the browser itself exits — a launcher still running after a short
 * grace period is treated as a successful launch rather than awaited.
 */
export const openUrl = (url: string) =>
  Effect.gen(function* () {
    const [command, args] =
      process.platform === "win32"
        ? (["rundll32.exe", ["url.dll,FileProtocolHandler", url]] as const)
        : process.platform === "darwin"
          ? (["open", [url]] as const)
          : (["xdg-open", [url]] as const);
    const handle = yield* ChildProcess.make(command, [...args], {
      shell: false,
    });
    const exitCode = yield* handle.exitCode.pipe(Effect.timeoutOption("3 seconds"));
    if (Option.isSome(exitCode) && exitCode.value !== 0) {
      return yield* new BrowserOpenFailed({ command, exitCode: exitCode.value });
    }
  }).pipe(Effect.scoped);

// Bun can hand concurrent dynamic imports of one module a half-evaluated
// namespace (a TDZ ReferenceError on its exports), so every lazy renderer
// module is imported through one shared promise.
const importOnce = <M>(load: () => Promise<M>) => {
  let module: Promise<M> | undefined;
  return () => (module ??= load());
};
const loadFormat = importOnce(() => import("./Cli/components/view/Format.tsx"));
const loadSigilRuntime = importOnce(() => import("./Cli/components/view/Runtime.tsx"));
const loadCapabilities = importOnce(() => import("./Cli/components/capabilities.ts"));

export interface TerminalOptions {
  readonly stdin?: NodeJS.ReadStream;
  readonly stdout?: NodeJS.WriteStream;
  readonly stderr?: NodeJS.WriteStream;
  /** Override automatic TTY input detection. Primarily useful for tests. */
  readonly input?: boolean;
  readonly colors?: boolean;
  readonly unicode?: boolean;
  /** Capture console output while the interactive renderer owns the tty. */
  readonly captureConsole?: boolean;
}

export type NonInteractiveOptions = Pick<TerminalOptions, "stdout" | "colors" | "unicode">;

const nonInteractiveFailure = (operation: string) =>
  new NonInteractiveTerminal({
    operation,
    message: `Cannot run ${operation} without an interactive terminal. Provide the equivalent command flags instead.`,
  });

export const makeNonInteractive = (options: NonInteractiveOptions = {}): Interaction["Service"] => {
  const stdout = options.stdout ?? process.stdout;
  const colors = options.colors ?? colorsEnabled(stdout);
  const unicode = options.unicode ?? unicodeEnabled();
  const glyphs = glyphsFor(unicode);
  const terminal: TerminalCapabilities = {
    input: false,
    columns: stdout.columns ?? 80,
    rows: stdout.rows ?? 24,
    colors,
    unicode,
    alternateScreen: false,
  };

  const colorize = (hex: string, value: string) =>
    colors ? `${ansiFg(hex)}${value}${ANSI_RESET}` : value;
  const muted = (value: string) => (colors ? `${ANSI_DIM}${value}${ANSI_RESET}` : value);

  // Plain-string equivalent of the CLI's `Status` component: colored glyph,
  // the message (painted for errors), and a muted `· detail` suffix.
  const statusText = (variant: StatusVariant, message: string, detail?: string) => {
    const glyph = colorize(statusColor(variant), glyphs[variant]);
    const body = variant === "error" ? colorize(statusColor(variant), message) : message;
    return `${glyph} ${body}${detail === undefined ? "" : ` ${muted(`· ${detail}`)}`}`;
  };

  const log = (variant: StatusVariant) => (message: string | MessageOptions) =>
    Effect.sync(() => {
      const { message: text, detail } = typeof message === "string" ? { message } : message;
      stdout.write(`${statusText(variant, text, detail)}\n`);
    });

  // Views are React layouts: load the static formatter only when one is
  // actually printed, so headless processes never pull in the renderer.
  const print = (view: View) =>
    Effect.promise(loadFormat).pipe(
      Effect.map(({ formatView }) =>
        formatView(view, { ...terminal, columns: stdout.columns ?? terminal.columns }),
      ),
      Effect.flatMap((text) =>
        text === "" ? Effect.void : Effect.sync(() => void stdout.write(`${text}\n`)),
      ),
    );

  const unavailable = (operation: string) => Effect.fail(nonInteractiveFailure(operation));

  const progress: Interaction["Service"]["progress"] = (initial) =>
    Effect.acquireRelease(
      log("info")({ message: initial.label, detail: initial.detail }).pipe(
        Effect.map((): ProgressHandle => {
          let current = initial;
          let settled = false;
          const settle = (variant: "success" | "error", message?: string) =>
            Effect.suspend(() => {
              if (settled) return Effect.void;
              settled = true;
              return log(variant)(message ?? current.label);
            });
          return {
            update: (next) =>
              Effect.sync(() => {
                if (!settled) current = next;
              }),
            succeed: (message) => settle("success", message),
            fail: (message) => settle("error", message),
            close: Effect.sync(() => {
              settled = true;
            }),
          };
        }),
      ),
      (handle) => handle.close,
    );

  return {
    terminal,
    output: {
      print,
      info: log("info"),
      success: log("success"),
      warning: log("warning"),
      error: log("error"),
    },
    prompt: {
      text: () => unavailable("text input"),
      password: () => unavailable("password input"),
      confirm: () => unavailable("confirmation"),
      select: () => unavailable("selection"),
      multiSelect: () => unavailable("multiple selection"),
      screen: (screen) => unavailable(screen.name),
    },
    // Without a screen there's nothing to paste a code into: print the URL
    // and wait, so device and poll logins still work headless.
    browserLogin: (login) =>
      Effect.gen(function* () {
        const openFailed = yield* Effect.isFailure(openUrl(login.url));
        yield* log("info")({
          message: `${login.provider} authorization: ${openFailed ? "open" : "opened"} ${login.url}`,
          detail: login.code === undefined ? undefined : `code ${login.code}`,
        });
        return yield* login.waitFor;
      }),
    live: (view) => print(view).pipe(Effect.as({ close: Effect.void })),
    progress,
    task: taskFromProgress(progress),
    session: () => unavailable("application"),
  };
};

/**
 * The append-only renderer: CI, redirected output, the programmatic engine
 * API, tests, and any headless embedding. Messages print as plain status
 * lines; every prompt fails immediately with the typed
 * {@link NonInteractiveTerminal}.
 */
export const layerNonInteractive = (options: NonInteractiveOptions = {}) =>
  Layer.effect(
    Interaction,
    Effect.sync(() => makeNonInteractive(options)),
  );

/**
 * The interactive Sigil renderer, regardless of what the terminal reports.
 * Prefer {@link layer}, which falls back to plain output without a TTY.
 */
export const layerSigil = (options: TerminalOptions = {}) =>
  Layer.effect(
    Interaction,
    Effect.gen(function* () {
      const { resolveCapabilities } = yield* Effect.promise(loadCapabilities);
      const { makeRuntime } = yield* Effect.promise(loadSigilRuntime);
      const { service } = yield* Effect.acquireRelease(
        Effect.sync(() => makeRuntime(options, { ...resolveCapabilities(options), input: true })),
        ({ dispose }) => Effect.promise(dispose),
      );
      return service;
    }),
  );

/**
 * The renderer this process's terminal supports: the interactive one when
 * stdin and stdout are a TTY and nothing opted out (`--no-input`, CI, coding
 * agents), plain output otherwise.
 */
export const layer = (options: TerminalOptions = {}) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const { resolveCapabilities } = yield* Effect.promise(loadCapabilities);
      const capabilities = resolveCapabilities(options);
      return capabilities.input
        ? layerSigil(options)
        : layerNonInteractive({
            stdout: options.stdout,
            colors: capabilities.colors,
            unicode: capabilities.unicode,
          });
    }),
  );
