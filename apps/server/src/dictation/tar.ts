/** Read the pinned npm archives. Links, extended headers and paths outside package/ are rejected. */
export function readTar(tar: Buffer): readonly { path: string; bytes: Buffer }[] {
  const files: { path: string; bytes: Buffer }[] = [];
  const paths = new Set<string>();
  let offset = 0;
  const string = (header: Buffer, start: number, length: number) =>
    header
      .subarray(start, start + length)
      .toString("utf8")
      .split("\0", 1)[0]!;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) return files;
    const checksum = Number.parseInt(string(header, 148, 8).trim(), 8);
    let actualChecksum = 0;
    for (let i = 0; i < 512; i++) actualChecksum += i >= 148 && i < 156 ? 32 : header[i]!;
    if (checksum !== actualChecksum) throw new Error("Invalid tar checksum.");
    const prefix = string(header, 345, 155);
    const name = `${prefix ? `${prefix}/` : ""}${string(header, 0, 100)}`;
    const components = name.split("/");
    if (
      components[0] !== "package" ||
      components.some((part) => part === ".." || part === ".") ||
      /[\\:\0]/.test(name)
    ) {
      throw new Error("Unsafe archive path.");
    }
    const size = Number.parseInt(string(header, 124, 12).trim(), 8);
    if (!Number.isSafeInteger(size) || size < 0 || offset + 512 + size > tar.length)
      throw new Error("Invalid tar size.");
    const type = header[156];
    if (type !== 0 && type !== 48 && type !== 53) throw new Error("Unsupported archive entry.");
    if (type !== 53) {
      const path = components.slice(1).join("/");
      if (!path || components.slice(1).some((part) => !part) || paths.has(path))
        throw new Error("Invalid archive file.");
      paths.add(path);
      files.push({ path, bytes: tar.subarray(offset + 512, offset + 512 + size) });
      if (files.length > 100) throw new Error("Too many archive entries.");
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  throw new Error("Truncated tar archive.");
}
