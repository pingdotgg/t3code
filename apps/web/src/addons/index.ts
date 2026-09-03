import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";

import type { ComposerAddonContext, ComposerAddonContribution } from "./composer";
import { bundledWebAddons } from "./registry";
import type { SidebarThreadAddonContribution } from "./sidebar";

const composerAddons = bundledWebAddons.flatMap((addon) =>
  addon.composer === undefined ? [] : [[addon.id, addon.composer] as const],
);
const sidebarAddons = bundledWebAddons.flatMap((addon) =>
  addon.sidebar === undefined ? [] : [addon.sidebar],
);

export function useComposerAddonContributions(
  context: ComposerAddonContext,
): readonly ComposerAddonContribution[] {
  return composerAddons.flatMap(([addonId, addon]) =>
    addon.useContributions(context).map((contribution) => ({ ...contribution, addonId })),
  );
}

export function readComposerAddonSubmissionPayloads(
  targetKey: string,
): Readonly<Record<string, unknown>> {
  return Object.fromEntries(
    composerAddons.flatMap(([addonId, addon]) => {
      const payload = addon.readSubmissionPayload?.(targetKey) ?? null;
      return payload === null ? [] : [[addonId, payload]];
    }),
  );
}

export function clearComposerAddonSubmissionPayloads(targetKey: string): void {
  for (const [, addon] of composerAddons) addon.clearSubmissionPayload?.(targetKey);
}

export function commitComposerAddonSubmissionPayloads(input: {
  readonly targetKey: string;
  readonly threadId: string;
  readonly payloads: Readonly<Record<string, unknown>>;
}): void {
  for (const [addonId, addon] of composerAddons) {
    const payload = input.payloads[addonId];
    if (payload === undefined) continue;
    addon.commitSubmission?.({
      targetKey: input.targetKey,
      threadId: input.threadId,
      payload,
    });
    addon.clearSubmissionPayload?.(input.targetKey);
  }
}

export function useSidebarAddonThreadContributions(
  threads: readonly EnvironmentThreadShell[],
): readonly SidebarThreadAddonContribution[] {
  return sidebarAddons.flatMap((addon) => addon.useThreadContributions(threads));
}

export { ComposerAddonSlot, composerAddonBlockingIssue } from "./composer";
export type { ComposerAddon, ComposerAddonContext, ComposerAddonContribution } from "./composer";
export { bundledWebAddons, validateWebAddons } from "./registry";
export type { WebAddon } from "./registry";
export { groupThreadsWithAddonContributions } from "./sidebar";
export type {
  SidebarAddon,
  SidebarThreadAddonContribution,
  SidebarThreadAddonGroup,
  SidebarThreadAddonMember,
} from "./sidebar";
