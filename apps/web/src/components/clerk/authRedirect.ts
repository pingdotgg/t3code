export interface ClerkSignInProps {
  forceRedirectUrl?: string;
  signUpForceRedirectUrl?: string;
}

export function resolveClerkSignInProps(href: string, isElectron: boolean): ClerkSignInProps {
  if (isElectron) {
    // Match @clerk/electron's callback root for direct sign-in and sign-up transfers;
    // otherwise Clerk's modal can submit its virtual route as the completion redirect.
    const redirectUrl = new URL("/", href).toString();
    return {
      forceRedirectUrl: redirectUrl,
      signUpForceRedirectUrl: redirectUrl,
    };
  }
  return { forceRedirectUrl: href };
}
