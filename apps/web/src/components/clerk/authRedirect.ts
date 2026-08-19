export interface ClerkSignInProps {
  forceRedirectUrl?: string;
  signUpForceRedirectUrl?: string;
}

// The sign-in modal can switch to sign-up, which follows its own redirect
// target; without one Clerk falls back to the URL the modal was opened from.
export function resolveClerkSignInProps(href: string): ClerkSignInProps {
  return { forceRedirectUrl: href, signUpForceRedirectUrl: href };
}
