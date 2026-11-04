import { createContext, useContext, type ReactNode } from "react";

interface ConnectAuth {
  readonly mode: "clerk" | "native";
  readonly canSignIn: boolean;
  readonly isLoaded: boolean;
  readonly isSignedIn: boolean;
  readonly userId: string | null;
  readonly identity: string | null;
  readonly getToken: (options?: unknown) => Promise<string | null>;
  readonly openSignIn: () => void;
  readonly signOut: () => Promise<void>;
  readonly openAccount: (page?: "mobile-clients" | "t3-connect" | "t3-chat") => void;
}

const ConnectAuthContext = createContext<ConnectAuth>({
  mode: "clerk",
  canSignIn: false,
  isLoaded: false,
  isSignedIn: false,
  userId: null,
  identity: null,
  getToken: async () => null,
  openSignIn: () => {},
  signOut: async () => {},
  openAccount: () => {},
});

export function ConnectAuthProvider({
  value,
  children,
}: {
  readonly value: ConnectAuth;
  readonly children: ReactNode;
}) {
  return <ConnectAuthContext value={value}>{children}</ConnectAuthContext>;
}

export function useConnectAuth(_options?: { readonly treatPendingAsSignedOut: boolean }) {
  return useContext(ConnectAuthContext);
}
