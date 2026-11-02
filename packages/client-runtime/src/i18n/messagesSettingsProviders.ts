/**
 * Settings: providers, models, usage, keybindings, snapshots.
 * Add the English key first, then its zh-Hans entry — English is the source of truth.
 */
export const enMessages = {} as const;

export const zhHansMessages: Partial<Record<keyof typeof enMessages, string>> = {};
