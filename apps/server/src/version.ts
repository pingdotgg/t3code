import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

let cachedVersion: string | null = null;

function resolveVersionFilePath(): string {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(currentDir, "..", "..", "..", "version.json");
}

export function getServerVersion(): string {
  if (cachedVersion) {
    return cachedVersion;
  }
  const versionPath = resolveVersionFilePath();
  try {
    const raw = fs.readFileSync(versionPath, "utf-8");
    const parsed = JSON.parse(raw) as { version?: string };
    if (parsed && typeof parsed.version === "string" && parsed.version.trim().length > 0) {
      cachedVersion = parsed.version.trim();
      return cachedVersion;
    }
  } catch {
    // fall through
  }
  cachedVersion = "unknown";
  return cachedVersion;
}
