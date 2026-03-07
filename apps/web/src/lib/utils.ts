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

export const newCommandId = (): CommandId => CommandId.makeUnsafe(crypto.randomUUID());

export const newProjectId = (): ProjectId => ProjectId.makeUnsafe(crypto.randomUUID());

export const newThreadId = (): ThreadId => ThreadId.makeUnsafe(crypto.randomUUID());

export const newMessageId = (): MessageId => MessageId.makeUnsafe(crypto.randomUUID());
