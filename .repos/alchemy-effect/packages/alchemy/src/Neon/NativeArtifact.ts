// @neon/config-runtime 1.6.1, dist/lib/native-packages.js: RUNTIME_TARGET.
export const neonRuntimeTarget = {
  os: "linux",
  cpu: "arm64",
  libc: "glibc",
} as const;

export const nativeArtifactError = (
  file: string,
  content: Uint8Array,
): string | undefined => {
  const elf =
    content[0] === 0x7f &&
    content[1] === 0x45 &&
    content[2] === 0x4c &&
    content[3] === 0x46;
  const magic =
    ((content[0]! << 24) |
      (content[1]! << 16) |
      (content[2]! << 8) |
      content[3]!) >>>
    0;
  if (elf) {
    // Header checks reject incompatible targets; addon ABI still needs runtime verification.
    if (
      content.length < 64 ||
      content[4] !== 2 ||
      content[5] !== 1 ||
      content[6] !== 1 ||
      ![0, 3].includes(content[7]!) ||
      ![2, 3].includes(content[16]!) ||
      content[17] !== 0 ||
      content[18] !== 183 ||
      content[19] !== 0 ||
      Buffer.from(content).includes(Buffer.from("ld-musl-"))
    )
      return `Native file is not Linux ARM64 glibc compatible: ${file}.`;
  } else if (
    /\.(?:node|dylib|dll|so(?:\.\d+)*)$/.test(file) ||
    [
      0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xbebafeca,
    ].includes(magic) ||
    (content[0] === 0x4d && content[1] === 0x5a)
  )
    return `Unsupported native format: ${file}. Expected Linux ARM64 glibc.`;
};
