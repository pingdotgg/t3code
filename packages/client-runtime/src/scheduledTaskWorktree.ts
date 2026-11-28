import { trimAsciiWhitespace, type VcsRef } from "@t3tools/contracts";

/** An empty base is automatic: the project's default branch, else `main` or `master`. */
export function scheduledTaskWorktreeBaseRef(
  baseRef: string,
  refs: ReadonlyArray<Pick<VcsRef, "name" | "isDefault">>,
): string {
  const picked = trimAsciiWhitespace(baseRef);
  if (picked) return picked;
  const defaultRef = refs.find((ref) => ref.isDefault);
  if (defaultRef) return defaultRef.name;
  for (const name of ["main", "master"]) {
    const match = refs.find((ref) => ref.name === name || ref.name === `origin/${name}`);
    if (match) return match.name;
  }
  return "main";
}
