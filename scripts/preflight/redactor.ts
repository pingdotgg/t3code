import { createHash } from "node:crypto";

const reservedSecretKeys = new Set(["value", "secret", "token", "apiKey", "password", "dsn"]);

export const mask = (input: string | Uint8Array): string => {
  const bytes = typeof input === "string" ? Buffer.from(input) : Buffer.from(input);
  const hash = createHash("sha256").update(bytes).digest("hex").slice(0, 8);

  return `len=${bytes.byteLength} sha256:${hash}`;
};

export const containsReservedSecretKey = (value: unknown): boolean => {
  if (Array.isArray(value)) {
    return value.some((item) => containsReservedSecretKey(item));
  }

  if (typeof value !== "object" || value === null) {
    return false;
  }

  for (const [key, nested] of Object.entries(value)) {
    if (reservedSecretKeys.has(key)) {
      return true;
    }

    if (containsReservedSecretKey(nested)) {
      return true;
    }
  }

  return false;
};
