export type T3ConnectAccountPageUrl = string;

const DISABLED_AUTH_RESULT = {
  isLoaded: true,
  isSignedIn: false as const,
  userId: null as string | null,
  sessionId: null as string | null,
  getToken: async (_options?: { template?: string; skipCache?: boolean }) => null as string | null,
  signOut: async () => {},
};

const DISABLED_CLERK_RESULT = {
  loaded: true,
  openSignIn: (_props?: Record<string, unknown>) => {},
  openSignUp: (_props?: Record<string, unknown>) => {},
  openUserProfile: (_props?: Record<string, unknown>) => {},
  redirectToSignIn: async (_props?: Record<string, unknown>) => {},
  signOut: async () => {},
};

const DISABLED_AUTH_PROMPT_RESULT = {
  openAuthPrompt: (_options?: unknown) => {},
  openSignIn: (_returnUrl?: string) => {},
  openSignUp: (_returnUrl?: string) => {},
  isReady: false,
  isLoading: false,
  isAvailable: false,
};

const DISABLED_ACCOUNT_PAGE_RESULT = {
  open: (_page?: T3ConnectAccountPageUrl) => {},
  openAccountPage: (_page?: T3ConnectAccountPageUrl) => {},
  openMobileClientsPage: () => {},
  openT3ChatPage: () => {},
  portals: null,
  isAvailable: false,
};

// oxlint-disable-next-line t3code/no-hookless-use-function -- disabled auth stub returns stable constant
export function useAuth(_options?: unknown) {
  return DISABLED_AUTH_RESULT;
}

// oxlint-disable-next-line t3code/no-hookless-use-function -- disabled auth stub returns stable constant
export function useClerk() {
  return DISABLED_CLERK_RESULT;
}

// oxlint-disable-next-line t3code/no-hookless-use-function -- disabled auth stub returns stable constant
export function useClerkLoadFailed(): boolean {
  return false;
}

export function retryClerkLoad(): void {}

export function resolveClerkSignInProps(
  _returnUrl?: string,
  _extra?: unknown,
): Record<string, unknown> {
  return {};
}

// oxlint-disable-next-line t3code/no-hookless-use-function -- disabled auth stub returns stable constant
export function useT3ConnectAuthPrompt(_options?: unknown) {
  return DISABLED_AUTH_PROMPT_RESULT;
}

// oxlint-disable-next-line t3code/no-hookless-use-function -- disabled auth stub returns stable constant
export function useT3ConnectAccountPage(_options?: unknown) {
  return DISABLED_ACCOUNT_PAGE_RESULT;
}

export function RemoveT3ConnectEnvironmentDialog(_props: Record<string, unknown>) {
  return null;
}
