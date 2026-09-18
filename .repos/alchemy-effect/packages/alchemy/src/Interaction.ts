/**
 * The engine's capability contract for talking to a human.
 *
 * `Interaction` is the narrow, presentation-free slice of terminal
 * interaction that non-CLI code (auth flows, the state store, engine
 * surfaces) may use: plain-string messages, a handful of prompt shapes,
 * and `task`. Nothing in its vocabulary knows a renderer exists — the CLI
 * provides an implementation backed by its terminal UI kit (see
 * `Cli/CliKit/interaction.ts`), while every other process gets
 * {@link layerNonInteractive}: messages render as plain status lines and
 * every prompt fails with the typed {@link NonInteractiveTerminal}.
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
import { ChildProcess } from "effect/unstable/process";
import { UserFacingError } from "./UserFacingError.ts";
import {
  ANSI_DIM,
  ANSI_RESET,
  ansiFg,
  colorsEnabled,
} from "./Util/Terminal.ts";
import { glyphsFor, statusColor, type StatusVariant } from "./Util/Theme.ts";
import { unicodeEnabled } from "./Util/Terminal.ts";

/** The user dismissed the active terminal interaction. */
export class TerminalCancelled extends Data.TaggedError("TerminalCancelled") {}

/** An interactive operation was requested without an interactive terminal. */
export class NonInteractiveTerminal extends Data.TaggedError(
  "NonInteractiveTerminal",
)<{
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

export interface MultiSelectOptions<Value> extends Omit<
  SelectOptions<Value>,
  "initialValue"
> {
  readonly initialValues?: ReadonlyArray<Value>;
  readonly required?: boolean;
}

export interface AwaitExternalOptions {
  readonly message: string;
  readonly waitingLabel: string;
  readonly url?: string;
  /** Short code the user must enter on the authorization page. */
  readonly code?: string;
  readonly openFailed?: boolean;
  /** Open the authorization URL again from the waiting screen. */
  readonly onOpen?: () => Promise<void>;
  /** Allow Enter to switch to manual code entry. @default true */
  readonly allowManualInput?: boolean;
  readonly inputLabel?: string;
  readonly placeholder?: string;
  readonly validate?: (value: string) => string | Error | undefined;
}

export interface ProgressOptions {
  readonly label: string;
  readonly detail?: string;
  /** Terminal window title while this progress view is active. */
  readonly title?: string;
  /** Animate the leading status glyph. @default true */
  readonly spinning?: boolean;
}

/**
 * The capability to ask or tell the human driving this process. Provided
 * by the CLI (terminal-backed) or {@link layerNonInteractive} (plain
 * output, typed prompt failures); never provided in child processes.
 */
export class Interaction extends Context.Service<
  Interaction,
  {
    readonly output: {
      readonly info: (message: string | MessageOptions) => Effect.Effect<void>;
      readonly success: (
        message: string | MessageOptions,
      ) => Effect.Effect<void>;
      readonly warning: (
        message: string | MessageOptions,
      ) => Effect.Effect<void>;
      readonly error: (message: string | MessageOptions) => Effect.Effect<void>;
    };

    readonly prompt: {
      readonly text: (
        options: TextInputOptions,
      ) => Effect.Effect<string, InteractionError>;
      readonly password: (
        options: PasswordInputOptions,
      ) => Effect.Effect<string, InteractionError>;
      readonly confirm: (
        options: ConfirmOptions,
      ) => Effect.Effect<boolean, InteractionError>;
      readonly select: <Value>(
        options: SelectOptions<Value>,
      ) => Effect.Effect<Value, InteractionError>;
      readonly multiSelect: <Value>(
        options: MultiSelectOptions<Value>,
      ) => Effect.Effect<ReadonlyArray<Value>, InteractionError>;
      readonly awaitExternal: (
        options: AwaitExternalOptions,
      ) => Effect.Effect<string, InteractionError>;
    };

    /** Run work behind a progress row and collapse it to a final status line. */
    readonly task: <A, E, R>(
      options: ProgressOptions,
      effect: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E, R>;
  }
>()("Alchemy::Interaction") {}

/** Effectful service accessors for code that must defer acquisition to use time. */
export const accessors = {
  output: {
    info: (message: string | MessageOptions) =>
      Effect.flatMap(Interaction, (service) => service.output.info(message)),
    success: (message: string | MessageOptions) =>
      Effect.flatMap(Interaction, (service) => service.output.success(message)),
    warning: (message: string | MessageOptions) =>
      Effect.flatMap(Interaction, (service) => service.output.warning(message)),
    error: (message: string | MessageOptions) =>
      Effect.flatMap(Interaction, (service) => service.output.error(message)),
  },
  prompt: {
    text: (options: TextInputOptions) =>
      Effect.flatMap(Interaction, (service) => service.prompt.text(options)),
    password: (options: PasswordInputOptions) =>
      Effect.flatMap(Interaction, (service) =>
        service.prompt.password(options),
      ),
    confirm: (options: ConfirmOptions) =>
      Effect.flatMap(Interaction, (service) => service.prompt.confirm(options)),
    select: <Value>(options: SelectOptions<Value>) =>
      Effect.flatMap(Interaction, (service) => service.prompt.select(options)),
    multiSelect: <Value>(options: MultiSelectOptions<Value>) =>
      Effect.flatMap(Interaction, (service) =>
        service.prompt.multiSelect(options),
      ),
  },
};

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
    const exitCode = yield* handle.exitCode.pipe(
      Effect.timeoutOption("3 seconds"),
    );
    if (Option.isSome(exitCode) && exitCode.value !== 0) {
      return yield* Effect.fail(
        new BrowserOpenFailed({ command, exitCode: exitCode.value }),
      );
    }
  }).pipe(Effect.scoped);

export interface NonInteractiveOptions {
  readonly stdout?: NodeJS.WriteStream;
  readonly colors?: boolean;
  readonly unicode?: boolean;
}

const makeNonInteractive = (
  options: NonInteractiveOptions,
): Interaction["Service"] => {
  const stdout = options.stdout ?? process.stdout;
  const colors = options.colors ?? colorsEnabled(stdout);
  const glyphs = glyphsFor(options.unicode ?? unicodeEnabled());

  const colorize = (hex: string, value: string) =>
    colors ? `${ansiFg(hex)}${value}${ANSI_RESET}` : value;
  const muted = (value: string) =>
    colors ? `${ANSI_DIM}${value}${ANSI_RESET}` : value;

  // Plain-string equivalent of the CLI's `Status` component: colored glyph,
  // the message (painted for errors), and a muted `· detail` suffix.
  const statusText = (
    variant: StatusVariant,
    message: string,
    detail?: string,
  ) => {
    const glyph = colorize(statusColor(variant), glyphs[variant]);
    const body =
      variant === "error" ? colorize(statusColor(variant), message) : message;
    return `${glyph} ${body}${detail === undefined ? "" : ` ${muted(`· ${detail}`)}`}`;
  };

  const log = (variant: StatusVariant) => (message: string | MessageOptions) =>
    Effect.sync(() => {
      const { message: text, detail } =
        typeof message === "string" ? { message } : message;
      stdout.write(`${statusText(variant, text, detail)}\n`);
    });

  const unavailable = (operation: string) =>
    Effect.fail(
      new NonInteractiveTerminal({
        operation,
        message: `Cannot run ${operation} without an interactive terminal. Provide the equivalent command flags instead.`,
      }),
    );

  return {
    output: {
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
      awaitExternal: () => unavailable("external authorization"),
    },
    task: (taskOptions, effect) =>
      Effect.suspend(() => {
        let settled = false;
        const settle = (variant: "success" | "error", message?: string) =>
          Effect.suspend(() => {
            if (settled) return Effect.void;
            settled = true;
            return log(variant)(message ?? taskOptions.label);
          });
        return log("info")({
          message: taskOptions.label,
          detail: taskOptions.detail,
        }).pipe(
          Effect.andThen(
            effect.pipe(
              Effect.onExit((exit) =>
                Exit.isSuccess(exit)
                  ? settle("success")
                  : // Interruption (Ctrl+C) is not a failure — leave the row
                    // unsettled instead of painting a red error status.
                    Cause.hasInterruptsOnly(exit.cause)
                    ? Effect.void
                    : settle("error"),
              ),
            ),
          ),
        );
      }),
  };
};

/**
 * The default Interaction for processes without a terminal renderer: the
 * programmatic engine API, tests, and any headless embedding. Messages
 * print as plain status lines; every prompt fails immediately with the
 * typed {@link NonInteractiveTerminal}.
 */
export const layerNonInteractive = (options: NonInteractiveOptions = {}) =>
  Layer.effect(
    Interaction,
    Effect.sync(() => makeNonInteractive(options)),
  );
