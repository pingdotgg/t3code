export const CURSOR_PROVIDER = "cursor" as const;
export const CURSOR_CLI_BINARY = "cursor-agent";

export function resolveCursorBinaryPath(binaryPath: string | null | undefined): string {
  const trimmed = binaryPath?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : CURSOR_CLI_BINARY;
}
