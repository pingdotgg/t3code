import type { KeybindingCommand } from "@t3tools/contracts";

const CODING_COMMAND = /^(?:terminal|rightPanel|threadPanel|diff|preview|script)\./;

/** Opens what chat mode hides. Closing a panel that is open still works. */
export const isCodingShortcut = (command: KeybindingCommand) =>
  command !== "rightPanel.close" && CODING_COMMAND.test(command);
