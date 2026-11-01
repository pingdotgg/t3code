// @effect-diagnostics nodeBuiltinImport:off - Build configuration resolves tags before an Effect runtime exists.
import * as NodeChildProcess from "node:child_process";

export function resolveTaggedSourceVersion(repoRoot: string, packageVersion: string): string {
  const git = (...args: string[]) =>
    NodeChildProcess.execFileSync("git", args, { cwd: repoRoot, encoding: "utf8", stdio: "pipe" });

  try {
    // Release jobs and local packagers may have already aligned the manifest to an explicit version.
    git("diff", "--quiet", "HEAD", "--", "apps/server/package.json");
    const tags = git("tag", "--points-at", "HEAD", "--list", "v[0-9]*")
      .trim()
      .split("\n")
      .filter((tag) => /^v\d+\.\d+\.\d+$/.test(tag));
    if (tags.length === 1) return tags[0]!.slice(1);
  } catch {
    // Source archives and builds without Git retain their package version.
  }
  return packageVersion;
}
