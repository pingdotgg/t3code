export function machineReadableGitDiffArgs(...args: ReadonlyArray<string>): ReadonlyArray<string> {
  return ["diff", "--no-ext-diff", ...args];
}
