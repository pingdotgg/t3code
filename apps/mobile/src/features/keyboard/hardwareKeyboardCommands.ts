import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useEffect } from "react";

export type HardwareKeyboardCommand =
  | "newTask"
  | "focusSearch"
  | "back"
  | "files"
  | "terminal"
  | "review"
  | "toggleSidebar";

type CommandHandler = () => boolean | void;

const handlers = new Map<HardwareKeyboardCommand, Set<CommandHandler>>();
const registrationListeners = new Set<() => void>();
let registrationVersion = 0;

/**
 * Registers a context-specific hardware-keyboard action. The most recently mounted handler gets
 * the first chance to consume the command, allowing focused screens to override app defaults.
 */
export function useHardwareKeyboardCommand(
  command: HardwareKeyboardCommand,
  handler: CommandHandler,
): void {
  useEffect(() => {
    const commandHandlers = handlers.get(command) ?? new Set<CommandHandler>();
    commandHandlers.add(handler);
    handlers.set(command, commandHandlers);
    registrationVersion += 1;
    registrationListeners.forEach((listener) => listener());
    return () => {
      commandHandlers.delete(handler);
      if (commandHandlers.size === 0) handlers.delete(command);
      registrationVersion += 1;
      registrationListeners.forEach((listener) => listener());
    };
  }, [command, handler]);
}

export function getRegisteredHardwareKeyboardCommands(): ReadonlySet<HardwareKeyboardCommand> {
  return new Set(handlers.keys());
}

export function getHardwareKeyboardCommandRegistrationVersion(): number {
  return registrationVersion;
}

export function subscribeToHardwareKeyboardCommandRegistrations(listener: () => void): () => void {
  registrationListeners.add(listener);
  return () => registrationListeners.delete(listener);
}

export function dispatchHardwareKeyboardCommand(command: HardwareKeyboardCommand): boolean {
  const commandHandlers = handlers.get(command);
  if (!commandHandlers) return false;
  for (const handler of [...commandHandlers].toReversed()) {
    if (handler() !== false) return true;
  }
  return false;
}

export function parseActiveThreadPath(pathname: string): {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
} | null {
  const match = /^\/threads\/([^/]+)\/([^/]+)(?:\/|$)/.exec(pathname);
  if (!match?.[1] || !match[2]) return null;
  try {
    return {
      environmentId: EnvironmentId.make(decodeURIComponent(match[1])),
      threadId: ThreadId.make(decodeURIComponent(match[2])),
    };
  } catch {
    return null;
  }
}
