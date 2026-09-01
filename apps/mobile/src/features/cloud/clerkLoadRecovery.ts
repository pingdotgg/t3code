export function clerkAccountRowLabel(input: {
  readonly email: string | undefined;
  readonly isLoaded: boolean;
  readonly isSignedIn: boolean;
}): string {
  if (!input.isLoaded) {
    return "Checking";
  }
  if (!input.isSignedIn) {
    return "Sign in";
  }
  return input.email ?? "Signed in";
}
