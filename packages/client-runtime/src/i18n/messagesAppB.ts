/**
 * Top-level app components (R–Z): sidebar, right panel, terminal drawer, update toasts, thread status.
 * Add the English key first, then its zh-Hans entry — English is the source of truth.
 */
export const enMessages = {} as const;

export const zhHansMessages: Partial<Record<keyof typeof enMessages, string>> = {};
