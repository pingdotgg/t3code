import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import type { TerminalProgressState } from "@alchemy.run/sigil/ansi";
import type { NonInteractiveTerminal } from "../../Interaction.ts";
import type {
  ConfirmOptions,
  CycleSelectOptions,
  AwaitExternalOptions,
  MessageOptions,
  InteractionError,
  LiveViewHandle,
  LiveViewOptions,
  MenuOptions,
  MultiSelectOptions,
  PasswordInputOptions,
  ProgressHandle,
  ProgressOptions,
  RenderOptions,
  Screen,
  SelectOptions,
  CliKitCapabilities,
  TextInputOptions,
  View,
} from "../components/types.ts";

/** The sole injected owner of terminal rendering and input for a CLI process. */
export class CliKit extends Context.Service<
  CliKit,
  {
    readonly terminal: CliKitCapabilities;

    /** Terminal-emulator progress displayed outside the rendered TUI. */
    readonly nativeProgress: {
      readonly set: (
        state: TerminalProgressState,
        value?: number,
      ) => Effect.Effect<void>;
    };

    readonly output: {
      /** Append a completed layout to terminal scrollback/output. */
      readonly print: (
        view: View,
        options?: RenderOptions,
      ) => Effect.Effect<void>;

      /** Render a layout without writing it. Useful for help, logs and snapshots. */
      readonly format: (view: View, options?: RenderOptions) => string;

      /** Effect form of `format`, useful when composing CLI programs. */
      readonly render: (
        view: View,
        options?: RenderOptions,
      ) => Effect.Effect<string>;

      /** Append an arbitrary visual layout. Prefer the semantic methods for logs. */
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
      readonly cycle: <State>(
        options: CycleSelectOptions<State>,
      ) => Effect.Effect<ReadonlyArray<State>, InteractionError>;
      readonly awaitExternal: (
        options: AwaitExternalOptions,
      ) => Effect.Effect<string, InteractionError>;

      /**
       * Display an application menu. Each invocation replaces the current app
       * flow, so looping back to a menu clears any prompts shown since the last
       * selection.
       */
      readonly menu: <Value>(
        options: MenuOptions<Value>,
      ) => Effect.Effect<Value, InteractionError>;

      /** Run an arbitrary interactive screen in the service's single live region. */
      readonly custom: <Value>(
        screen: Screen<Value>,
      ) => Effect.Effect<Value, InteractionError>;
    };

    /** Run a sequence of prompts as one owned interaction. */
    readonly wizard: <A, E, R>(
      effect: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E | NonInteractiveTerminal, R>;

    /**
     * Keep one renderer alive while an Effect drives menus, screens and prompt
     * flows. The application is cleared and the renderer exits when it settles.
     */
    readonly application: <A, E, R>(
      effect: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E | NonInteractiveTerminal, R>;

    readonly live: {
      /**
       * Add a mutable row to the live region. The handle is idempotent, and
       * the enclosing Scope closes it as a backstop so interruption can never
       * leave an orphaned row keeping the renderer mounted.
       */
      readonly progress: (
        options: ProgressOptions,
      ) => Effect.Effect<ProgressHandle, never, Scope.Scope>;
      /**
       * Mount a live layout while the scope is open. The view is immutable —
       * dynamic content flows through a caller-owned store (`LiveStore` +
       * `useLiveStore`) that the view's component subscribes to.
       */
      readonly open: (
        view: View,
        options?: LiveViewOptions,
      ) => Effect.Effect<LiveViewHandle, never, Scope.Scope>;
    };

    /** Run work behind a progress row and collapse it to a final status line. */
    readonly task: <A, E, R>(
      options: ProgressOptions,
      effect: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E, R>;
  }
>()("Alchemy::CliKit") {}

/** Effectful service accessors for code that must defer acquisition to use time. */
export const accessors = {
  output: {
    info: (message: string | MessageOptions) =>
      Effect.flatMap(CliKit, (service) => service.output.info(message)),
    success: (message: string | MessageOptions) =>
      Effect.flatMap(CliKit, (service) => service.output.success(message)),
    warning: (message: string | MessageOptions) =>
      Effect.flatMap(CliKit, (service) => service.output.warning(message)),
    error: (message: string | MessageOptions) =>
      Effect.flatMap(CliKit, (service) => service.output.error(message)),
  },
  prompt: {
    text: (options: TextInputOptions) =>
      Effect.flatMap(CliKit, (service) => service.prompt.text(options)),
    password: (options: PasswordInputOptions) =>
      Effect.flatMap(CliKit, (service) => service.prompt.password(options)),
    confirm: (options: ConfirmOptions) =>
      Effect.flatMap(CliKit, (service) => service.prompt.confirm(options)),
    select: <Value>(options: SelectOptions<Value>) =>
      Effect.flatMap(CliKit, (service) => service.prompt.select(options)),
    multiSelect: <Value>(options: MultiSelectOptions<Value>) =>
      Effect.flatMap(CliKit, (service) => service.prompt.multiSelect(options)),
  },
};

export const ApplicationPresentation = Context.Reference<
  "inline" | "alternate"
>("Alchemy::CliKit/ApplicationPresentation", { defaultValue: () => "inline" });

/** Pipeable presentation modifiers for {@link CliKit.application}. */
export const Application = {
  alternate: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(ApplicationPresentation, "alternate" as const),
    ),
};
