import { createHash } from "node:crypto";

export const createStableHash = (value: string): string =>
  createHash("sha256").update(value).digest("hex");
