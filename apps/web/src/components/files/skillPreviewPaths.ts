export function collapseDotSegments(path: string): string {
  const unix = path.replaceAll("\\", "/");
  const unc = unix.startsWith("//");
  const drive = /^[A-Za-z]:/.exec(unix)?.[0];
  const rooted = unix.startsWith("/") || drive !== undefined;
  const prefix = unc ? "//" : (drive ?? (unix.startsWith("/") ? "/" : ""));
  let rest = unix;
  if (unc) rest = rest.slice(2).replace(/^\/+/, "");
  else if (drive) rest = rest.slice(drive.length).replace(/^\/+/, "");
  else if (unix.startsWith("/")) rest = rest.slice(1);

  const resolved: string[] = [];
  for (const segment of rest.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (resolved.length > 0) resolved.pop();
      else if (!rooted) resolved.push("..");
      continue;
    }
    resolved.push(segment);
  }
  const joined = resolved.join("/");
  if (prefix === "") return joined;
  if (prefix === "/" || prefix === "//") {
    return joined.length > 0 ? `${prefix}${joined}` : prefix === "//" ? "//" : "/";
  }
  return joined.length > 0 ? `${prefix}/${joined}` : prefix;
}

export function relativePathWithinRoot(rootPath: string, targetPath: string): string | null {
  const collapsedRoot = collapseDotSegments(rootPath);
  const root = collapsedRoot === "/" ? "/" : collapsedRoot.replace(/\/+$/, "");
  if (!root) return null;
  const target = collapseDotSegments(targetPath);
  const caseInsensitive = /^[A-Za-z]:(?:\/|$)/.test(root);
  const comparableRoot = caseInsensitive ? root.toLowerCase() : root;
  const comparableTarget = caseInsensitive ? target.toLowerCase() : target;
  const comparablePrefix = comparableRoot === "/" ? "/" : `${comparableRoot}/`;
  if (!comparableTarget.startsWith(comparablePrefix)) return null;
  return target.slice(root === "/" ? 1 : root.length + 1);
}

export function skillRootPath(skillPath: string): string {
  const separatorIndex = Math.max(skillPath.lastIndexOf("/"), skillPath.lastIndexOf("\\"));
  return separatorIndex < 0 ? skillPath : skillPath.slice(0, separatorIndex);
}

export function relativePathWithinSkill(skillPath: string, targetPath: string): string | null {
  return relativePathWithinRoot(skillRootPath(skillPath), targetPath);
}
