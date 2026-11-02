/**
 * Top-level app components (A–Q): chat view shell, branch toolbar, command palette, dialogs, diff panel, git actions.
 * Add the English key first, then its zh-Hans entry — English is the source of truth.
 */
export const enMessages = {} as const;

export const zhHansMessages: Partial<Record<keyof typeof enMessages, string>> = {};
