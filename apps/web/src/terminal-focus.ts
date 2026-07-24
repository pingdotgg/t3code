export function shouldFocusTerminalAfterSetup(input: {
  readonly autoFocus: boolean;
  readonly hasMounted: boolean;
  readonly restorePreviousTerminalFocus: boolean;
}): boolean {
  return input.restorePreviousTerminalFocus || (!input.hasMounted && input.autoFocus);
}
