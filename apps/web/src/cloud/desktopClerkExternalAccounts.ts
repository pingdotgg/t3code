interface DesktopClerkExternalAccountParams {
  readonly redirectUrl?: string;
  readonly [key: string]: unknown;
}

interface DesktopClerkExternalAccount {
  reauthorize: (params: DesktopClerkExternalAccountParams) => Promise<DesktopClerkExternalAccount>;
}

interface DesktopClerkUser {
  readonly externalAccounts: readonly DesktopClerkExternalAccount[];
  createExternalAccount: (
    params: DesktopClerkExternalAccountParams,
  ) => Promise<DesktopClerkExternalAccount>;
  reload: () => Promise<unknown>;
}

interface DesktopClerkExternalAccountBridge {
  readonly createCloudAuthRequest: () => Promise<string>;
  readonly onCloudAuthCallback: (listener: (rawUrl: string) => void) => () => void;
}

interface DesktopClerkExternalAccountAdapter {
  readonly dispose: () => void;
  readonly installUser: (user: DesktopClerkUser) => void;
}

interface MakeDesktopClerkExternalAccountAdapterInput {
  readonly bridge: DesktopClerkExternalAccountBridge;
  readonly reportError?: (message: string, error: unknown) => void;
}

// Clerk's profile component uses window.location.href as the OAuth callback and navigates the
// current window to the provider. Keep the upstream component intact while adapting its resource
// calls to the native callback bridge:
// https://github.com/clerk/javascript/blob/52861184477bee99c71552000311a289e91d3b59/packages/ui/src/components/UserProfile/ConnectedAccountsMenu.tsx
// https://github.com/clerk/javascript/blob/52861184477bee99c71552000311a289e91d3b59/packages/ui/src/components/UserProfile/ConnectedAccountsSection.tsx
export function makeDesktopClerkExternalAccountAdapter({
  bridge,
  reportError = console.error,
}: MakeDesktopClerkExternalAccountAdapterInput): DesktopClerkExternalAccountAdapter {
  const installedAccounts = new WeakSet<object>();
  const installedUsers = new WeakSet<object>();
  let callbackGeneration = 0;
  let callbackCleanup: (() => void) | null = null;

  const clearCallback = () => {
    callbackGeneration += 1;
    callbackCleanup?.();
    callbackCleanup = null;
  };

  const createRedirectUrl = async (user: DesktopClerkUser): Promise<string> => {
    clearCallback();
    const redirectUrl = await bridge.createCloudAuthRequest();
    const generation = callbackGeneration;
    callbackCleanup = bridge.onCloudAuthCallback(() => {
      if (generation !== callbackGeneration) return;
      clearCallback();
      void user.reload().catch((error: unknown) => {
        reportError("Failed to reload Clerk after desktop account linking.", error);
      });
    });
    return redirectUrl;
  };

  const installAccount = (user: DesktopClerkUser, account: DesktopClerkExternalAccount): void => {
    if (installedAccounts.has(account)) return;
    installedAccounts.add(account);

    const reauthorize = account.reauthorize.bind(account);
    account.reauthorize = async (params) => {
      const redirectUrl = await createRedirectUrl(user);
      try {
        const nextAccount = await reauthorize({ ...params, redirectUrl });
        installAccount(user, nextAccount);
        return nextAccount;
      } catch (error) {
        clearCallback();
        throw error;
      }
    };
  };

  const installUser = (user: DesktopClerkUser): void => {
    for (const account of user.externalAccounts) {
      installAccount(user, account);
    }
    if (installedUsers.has(user)) return;
    installedUsers.add(user);

    const createExternalAccount = user.createExternalAccount.bind(user);
    user.createExternalAccount = async (params) => {
      const redirectUrl = await createRedirectUrl(user);
      try {
        const account = await createExternalAccount({ ...params, redirectUrl });
        installAccount(user, account);
        return account;
      } catch (error) {
        clearCallback();
        throw error;
      }
    };
  };

  return {
    dispose: clearCallback,
    installUser,
  };
}

export type { DesktopClerkExternalAccountAdapter, DesktopClerkUser };
