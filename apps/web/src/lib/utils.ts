import { CommandId, MessageId, ProjectId, ThreadId } from "@t3tools/contracts";
import { type CxOptions, cx } from "class-variance-authority";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: CxOptions) {
  return twMerge(cx(inputs));
}

export function isMacPlatform(platform: string): boolean {
  return /mac|iphone|ipad|ipod/i.test(platform);
}

export function isWindowsPlatform(platform: string): boolean {
  return /^win(dows)?/i.test(platform);
}

/**
 * Generate a UUID v4. Falls back to `crypto.getRandomValues` when
 * `crypto.randomUUID` is unavailable (non-secure HTTP contexts on mobile).
 */
export function uuid(): string {
  if (typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // variant 1
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export const newCommandId = (): CommandId => CommandId.makeUnsafe(uuid());

export const newProjectId = (): ProjectId => ProjectId.makeUnsafe(uuid());

export const newThreadId = (): ThreadId => ThreadId.makeUnsafe(uuid());

export const newMessageId = (): MessageId => MessageId.makeUnsafe(uuid());
