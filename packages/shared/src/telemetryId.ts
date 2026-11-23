import { sha256Hex } from "./sha256Hex.ts";

/**
 * Hashes an identifier before it reaches analytics. Clients and the server both
 * use it, so one Connect account gives the same owner id on every surface.
 */
export const hashTelemetryId = sha256Hex;

/** True for a `hashTelemetryId` result. The server accepts only this shape from clients. */
export const isTelemetryIdHash = (value: string): boolean => /^[0-9a-f]{64}$/u.test(value);
