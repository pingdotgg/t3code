export interface ClerkSignInProps {
  forceRedirectUrl?: string;
  signUpForceRedirectUrl?: string;
}

// Clerk's native-app allowlist only authorizes the bare renderer root
// (t3code://app/), which @clerk/electron's OAuth transport already supplies,
// so any page-derived redirect override gets the whole sign-in request
// rejected. On Electron, omit the override and let Clerk use its defaults.
export function resolveClerkSignInProps(href: string, isElectron: boolean): ClerkSignInProps {
  if (isElectron) return {};
  // The sign-in modal can switch to sign-up, which follows its own redirect
  // target; without one Clerk falls back to the URL the modal was opened from.
  return { forceRedirectUrl: href, signUpForceRedirectUrl: href };
}
