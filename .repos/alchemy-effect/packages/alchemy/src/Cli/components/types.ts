// The interaction vocabulary belongs to the engine's `Interaction` contract.
// Re-exported here so the CLI's components keep one local import for their
// whole type surface.
export type {
  BrowserLoginOptions,
  Choice,
  ConfirmOptions,
  InteractionError,
  LiveViewHandle,
  LiveViewOptions,
  MessageOptions,
  MultiSelectOptions,
  PasswordInputOptions,
  ProgressHandle,
  ProgressOptions,
  ScreenController,
  SelectOptions,
  SessionOptions,
  TerminalCapabilities,
  TerminalOptions,
  TextInputOptions,
  View,
} from "../../Interaction.ts";
export { Screen } from "../../Interaction.ts";

export interface RenderOptions {
  readonly columns?: number;
  readonly colors?: boolean;
}

export interface CycleChoice<State> {
  readonly label: string;
  readonly description?: string;
  readonly states: ReadonlyArray<{
    readonly value: State;
    readonly label?: string;
    readonly icon?: string;
    readonly variant?: "neutral" | "accent" | "info" | "success" | "warning" | "error";
  }>;
}

export interface CycleSelectOptions<State> {
  readonly message: string;
  readonly options: ReadonlyArray<CycleChoice<State>>;
  readonly visibleCount?: number;
  /** Keep the prompt open when Enter is pressed without changing any row. */
  readonly requireChange?: boolean;
  readonly unchangedMessage?: string;
}
