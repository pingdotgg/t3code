export interface ClerkSignInProps {
  forceRedirectUrl?: string;
  signUpForceRedirectUrl?: string;
}

export function resolveClerkSignInProps(href: string, isElectron: boolean): ClerkSignInProps {
  if (isElectron) {
    // @clerk/electron supplies the authorized renderer root for OAuth callbacks, but Clerk's
    // modal can submit its virtual route as the completion redirect for sign-in or sign-up.
    const redirectUrl = new URL("/", href).toString();
    return {
      forceRedirectUrl: redirectUrl,
      signUpForceRedirectUrl: redirectUrl,
    };
  }
  return { forceRedirectUrl: href };
}
