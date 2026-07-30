export function resolveSettingsAuthHeaderOptions(input: {
  readonly isLoaded: boolean;
  readonly isSignedIn: boolean | undefined;
}) {
  return {
    headerShown: !input.isLoaded || input.isSignedIn === true,
    title: input.isSignedIn ? "Account" : "Sign in",
  };
}
