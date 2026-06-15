export function fileContentRevision(contents: string): string {
  let hash = 2_166_136_261;
  for (let index = 0; index < contents.length; index += 1) {
    hash ^= contents.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return `${contents.length}:${(hash >>> 0).toString(36)}`;
}

export function projectFileCacheKey(cwd: string, relativePath: string, contents: string): string {
  return `${cwd}:${relativePath}:${fileContentRevision(contents)}`;
}
