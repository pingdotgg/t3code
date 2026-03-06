import fs from "node:fs";

const RETRYABLE_REMOVE_ERROR_CODES = new Set(["EBUSY", "ENOTEMPTY", "EPERM"]);

function isRetryableRemoveError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  const code = "code" in error ? error.code : undefined;
  return typeof code === "string" && RETRYABLE_REMOVE_ERROR_CODES.has(code);
}

export async function removeDirectoryBestEffort(
  dir: string,
  options?: {
    readonly maxRetries?: number;
    readonly retryDelayMs?: number;
  },
): Promise<void> {
  const maxRetries = options?.maxRetries ?? 20;
  const retryDelayMs = options?.retryDelayMs ?? 100;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      if (!isRetryableRemoveError(error)) {
        throw error;
      }

      if (attempt === maxRetries) {
        return;
      }

      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    }
  }
}
