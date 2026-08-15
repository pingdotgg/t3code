export interface ClerkSignInProps {
  forceRedirectUrl?: string;
  signUpForceRedirectUrl?: string;
}

export function resolveClerkSignInProps(href: string, isElectron: boolean): ClerkSignInProps {
  if (isElectron) {
    // Electron routes through the hash, so reset any Clerk virtual pathname without losing the T3 page.
    const redirectUrl = new URL(href);
    redirectUrl.pathname = "/";
    redirectUrl.search = "";

    return {
      forceRedirectUrl: redirectUrl.toString(),
      signUpForceRedirectUrl: redirectUrl.toString(),
    };
  }
  // Sign-up completes on its own redirect, so it needs the same target as
  // sign-in. Without it Clerk falls back to its dashboard default and lands on
  // a route this app does not serve.
  return { forceRedirectUrl: href, signUpForceRedirectUrl: href };
}
