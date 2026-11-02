/**
 * Onboarding, auth, cloud, guest, devices, usage, sidebar parts, desktop, UI primitives, routes, hooks, and state.
 * Add the English key first, then its zh-Hans entry — English is the source of truth.
 */
export const enMessages = {} as const;

export const zhHansMessages: Partial<Record<keyof typeof enMessages, string>> = {};
