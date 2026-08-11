export const WSL_RUNTIME_ARCHIVE_FILENAME = "wsl-runtime.tar.gz";
export const WSL_RUNTIME_ARCHIVE_HASH_FILENAME = `${WSL_RUNTIME_ARCHIVE_FILENAME}.sha256`;
export const WSL_RUNTIME_ARCHIVE_STAGE_DIRECTORY = "apps/desktop/prod-resources";

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

export const parseWslRuntimeArchiveHash = (value: string): string | null => {
  const normalized = value.trim().toLowerCase();
  return SHA256_PATTERN.test(normalized) ? normalized : null;
};
