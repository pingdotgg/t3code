export interface ClerkSignInProps {
  forceRedirectUrl?: string;
  signUpForceRedirectUrl?: string;
}

// Clerk's native-app allowlist only authorizes the bare renderer root
// (t3code://app/). Keep both modal completion paths on that root; otherwise
// Clerk derives a virtual sign-up URL from the current hash route and rejects it.
// @clerk/electron supplies the same root separately for the OAuth callback.
export function resolveClerkSignInProps(href: string, isElectron: boolean): ClerkSignInProps {
  if (!isElectron) return { forceRedirectUrl: href };

  const rendererRoot = new URL("/", href).toString();
  return { forceRedirectUrl: rendererRoot, signUpForceRedirectUrl: rendererRoot };
}
