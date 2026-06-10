import { CommandId, MessageId, ProjectId, QueuedTurnId, ThreadId } from "@t3tools/contracts";
import { randomUUID as randomUUIDv4 } from "@t3tools/shared/uuid";
import { type CxOptions, cx } from "class-variance-authority";
import { twMerge } from "tailwind-merge";
import { DraftId } from "../composerDraftStore";

export function cn(...inputs: CxOptions) {
  return twMerge(cx(inputs));
}

export function isMacPlatform(platform: string): boolean {
  return /mac|iphone|ipad|ipod/i.test(platform);
}

export function isWindowsPlatform(platform: string): boolean {
  return /^win(dows)?/i.test(platform);
}

export function isLinuxPlatform(platform: string): boolean {
  return /linux/i.test(platform);
}

export function randomUUID(): string {
  if (typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return randomUUIDv4();
}

export const newCommandId = (): CommandId => CommandId.make(randomUUID());

export const newProjectId = (): ProjectId => ProjectId.make(randomUUID());

export const newThreadId = (): ThreadId => ThreadId.make(randomUUID());

export const newDraftId = (): DraftId => DraftId.make(randomUUID());

export const newMessageId = (): MessageId => MessageId.make(randomUUID());

export const newQueuedTurnId = (): QueuedTurnId => QueuedTurnId.make(randomUUID());
