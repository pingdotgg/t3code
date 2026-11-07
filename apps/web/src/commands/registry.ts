import type { KeybindingCommand } from "@t3tools/contracts";
import { parseKeybindingWhenExpression } from "@t3tools/shared/keybindings";

import { matchesWhenClause, type ShortcutMatchContext } from "../keybindings";
import {
  allStaticCommandContributions,
  scriptCommandContribution,
  staticCommandContribution,
} from "./catalog";
import type {
  CommandContribution,
  CommandRunContext,
  CommandRunHandler,
  RegisterCommandOptions,
  RegisteredCommand,
} from "./types";

interface HandlerEntry {
  readonly handler: CommandRunHandler;
  readonly when?: RegisterCommandOptions["when"];
}

const handlersByCommand = new Map<KeybindingCommand, HandlerEntry[]>();
const dynamicContributions = new Map<KeybindingCommand, CommandContribution>();

function contributionFor(command: KeybindingCommand): CommandContribution {
  return (
    staticCommandContribution(command) ??
    dynamicContributions.get(command) ??
    scriptCommandContribution(command)
  );
}

/**
 * Register a run handler for a command. Newest registration wins; returning
 * `false` falls through to the next older handler. Unregister on unmount so
 * ChatView/palette scopes do not leak.
 */
export function registerCommand(
  command: KeybindingCommand,
  handler: CommandRunHandler,
  options?: RegisterCommandOptions & { readonly contribution?: Omit<CommandContribution, "id"> },
): () => void {
  const contribution = options?.contribution;
  if (!staticCommandContribution(command) && contribution) {
    dynamicContributions.set(command, { id: command, ...contribution });
  } else if (!staticCommandContribution(command) && !dynamicContributions.has(command)) {
    dynamicContributions.set(command, scriptCommandContribution(command));
  }

  const stack = handlersByCommand.get(command) ?? [];
  const entry: HandlerEntry = { handler, when: options?.when };
  stack.push(entry);
  handlersByCommand.set(command, stack);

  return () => {
    const current = handlersByCommand.get(command);
    if (!current) return;
    const index = current.lastIndexOf(entry);
    if (index !== -1) current.splice(index, 1);
    if (current.length === 0) {
      handlersByCommand.delete(command);
      if (!staticCommandContribution(command)) dynamicContributions.delete(command);
    }
  };
}

export function executeCommand(
  command: KeybindingCommand,
  context: CommandRunContext = { source: "palette" },
): boolean {
  const stack = handlersByCommand.get(command);
  if (!stack || stack.length === 0) return false;
  for (let index = stack.length - 1; index >= 0; index -= 1) {
    const entry = stack[index];
    if (!entry) continue;
    // Scope `when` only gates keystrokes; palette/menu still reach the handler.
    if (
      entry.when &&
      context.source === "keybinding" &&
      context.event &&
      !entry.when(context.event)
    ) {
      continue;
    }
    if (entry.handler(context) !== false) return true;
    // A handler that consumed the key (preventDefault) ends the walk even if it
    // returned false, matching per-scope fallthrough in the dispatcher.
    if (context.event?.defaultPrevented) return true;
  }
  return false;
}

export function hasCommandHandler(command: KeybindingCommand): boolean {
  return (handlersByCommand.get(command)?.length ?? 0) > 0;
}

export function isCommandEnabled(
  command: KeybindingCommand,
  context: ShortcutMatchContext,
): boolean {
  const contribution = contributionFor(command);
  if (!contribution.when) return true;
  const whenAst = parseKeybindingWhenExpression(contribution.when);
  return matchesWhenClause(whenAst ?? undefined, context);
}

/** Palette rows: contributed commands that are not explicitly hidden. */
export function listPaletteCommands(
  context: ShortcutMatchContext,
): ReadonlyArray<RegisteredCommand> {
  const seen = new Set<KeybindingCommand>();
  const result: RegisteredCommand[] = [];

  const push = (contribution: CommandContribution) => {
    if (seen.has(contribution.id) || contribution.palette === false) return;
    seen.add(contribution.id);
    result.push({
      ...contribution,
      enabled: isCommandEnabled(contribution.id, context),
      hasHandler: hasCommandHandler(contribution.id),
    });
  };

  for (const contribution of allStaticCommandContributions()) push(contribution);
  for (const contribution of dynamicContributions.values()) push(contribution);
  return result;
}
