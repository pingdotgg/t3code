import type { KeybindingCommand } from "@t3tools/contracts";

export type CommandCategory =
  | "Navigation"
  | "Threads"
  | "Composer"
  | "Terminal"
  | "Preview & diff"
  | "Appearance"
  | "Usage"
  | "Project scripts"
  | "Other";

export type CommandSource = "keybinding" | "palette" | "menu";

export interface CommandRunContext {
  readonly source: CommandSource;
  readonly event?: KeyboardEvent;
}

/**
 * Return `false` to signal the invocation was not handled (key event may fall through).
 * Palette and menu treat any non-false result as handled.
 */
export type CommandRunHandler = (context: CommandRunContext) => boolean | void;

/** Optional per-handler gate, evaluated for keybinding invocations that carry an event. */
export type CommandHandlerWhen = (event: KeyboardEvent) => boolean;

export interface RegisterCommandOptions {
  readonly when?: CommandHandlerWhen;
}

export interface CommandContribution {
  readonly id: KeybindingCommand;
  readonly title: string;
  readonly category: CommandCategory;
  readonly searchTerms: ReadonlyArray<string>;
  /**
   * Palette enablement (VS Code `enablement`). Omit for always enabled.
   * Keybinding `when` clauses still gate which chord fires the command.
   */
  readonly when?: string;
  /** Hide from the command palette while remaining keybindable. */
  readonly palette?: false;
}

export interface RegisteredCommand extends CommandContribution {
  readonly enabled: boolean;
  readonly hasHandler: boolean;
}
