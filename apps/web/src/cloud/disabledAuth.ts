export type T3ConnectAccountPageUrl = string;

export function useAuth(_options?: unknown) {
  return {
    isLoaded: true,
    isSignedIn: false as const,
    userId: null as string | null,
    sessionId: null as string | null,
    getToken: async (_options?: { template?: string; skipCache?: boolean }) =>
      null as string | null,
    signOut: async () => {},
  };
}

export function useClerk() {
  return {
    loaded: true,
    openSignIn: (_props?: Record<string, unknown>) => {},
    openSignUp: (_props?: Record<string, unknown>) => {},
    openUserProfile: (_props?: Record<string, unknown>) => {},
    redirectToSignIn: async (_props?: Record<string, unknown>) => {},
    signOut: async () => {},
  };
}

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

export function useT3ConnectAuthPrompt(_options?: unknown) {
  return {
    openAuthPrompt: (_options?: unknown) => {},
    openSignIn: (_returnUrl?: string) => {},
    openSignUp: (_returnUrl?: string) => {},
    isReady: false,
    isLoading: false,
    isAvailable: false,
  };
}

export function useT3ConnectAccountPage(_options?: unknown) {
  return {
    open: (_page?: T3ConnectAccountPageUrl) => {},
    openAccountPage: (_page?: T3ConnectAccountPageUrl) => {},
    openMobileClientsPage: () => {},
    openT3ChatPage: () => {},
    portals: null,
    isAvailable: false,
  };
}

export function RemoveT3ConnectEnvironmentDialog(_props: Record<string, unknown>) {
  return null;
}
