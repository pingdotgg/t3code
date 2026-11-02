/**
 * Settings: projects, source control, worktrees, integrations, devices, browser import, scheduled tasks.
 * Add the English key first, then its zh-Hans entry — English is the source of truth.
 */
export const enMessages = {} as const;

export const zhHansMessages: Partial<Record<keyof typeof enMessages, string>> = {};
