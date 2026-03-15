import { readPathForDesktopRuntime } from "@t3tools/shared/shell";

export function fixPath(): void {
  try {
    const result = readPathForDesktopRuntime(process.platform, process.env.SHELL);
    if (result) {
      process.env.PATH = result;
    }
  } catch {
    // Keep inherited PATH if shell lookup fails.
  }
}
