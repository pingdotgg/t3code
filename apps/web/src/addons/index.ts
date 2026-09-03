import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type { ScopedThreadRef } from "@t3tools/contracts";

import type {
  ComposerAddon,
  ComposerAddonContext,
  ComposerAddonContribution,
  ComposerAddonSubmissionPayload,
} from "./composer";
import { bundledWebAddons } from "./registry";
import type {
  SidebarThreadAddonContribution,
  SidebarThreadAddonContributionInput,
} from "./sidebar";

type ComposerAddonEntry = readonly [addonId: string, addon: ComposerAddon];

export interface ComposerAddonLifecycleFailure {
  readonly addonId: string;
  readonly phase: "read" | "commit" | "clear";
  readonly error: unknown;
}

export interface ComposerAddonSubmissionSnapshot {
  readonly payloads: Readonly<Record<string, ComposerAddonSubmissionPayload>>;
  readonly failures: readonly ComposerAddonLifecycleFailure[];
}

const composerAddons: readonly ComposerAddonEntry[] = bundledWebAddons.flatMap((addon) =>
  addon.composer === undefined ? [] : [[addon.id, addon.composer] as const],
);
const sidebarAddons = bundledWebAddons.flatMap((addon) =>
  addon.sidebar === undefined ? [] : [[addon.id, addon.sidebar] as const],
);

function assertUniqueContributionIds(addonId: string, contributionIds: readonly string[]): void {
  const seen = new Set<string>();
  for (const contributionId of contributionIds) {
    if (contributionId.trim() === "") {
      throw new Error(`Addon '${addonId}' returned an empty contribution id`);
    }
    if (seen.has(contributionId)) {
      throw new Error(`Addon '${addonId}' returned duplicate contribution id '${contributionId}'`);
    }
    seen.add(contributionId);
  }
}

export function useComposerAddonContributions(
  context: ComposerAddonContext,
): readonly ComposerAddonContribution[] {
  return composerAddons.flatMap(([addonId, addon]) => {
    const contributions = addon.useContributions(context);
    assertUniqueContributionIds(
      addonId,
      contributions.map((contribution) => contribution.contributionId),
    );
    return contributions.map((contribution) => ({ ...contribution, addonId }));
  });
}

export function readComposerAddonSubmissionPayloadsFrom(
  addons: readonly ComposerAddonEntry[],
  targetKey: string,
): ComposerAddonSubmissionSnapshot {
  const payloads: Record<string, ComposerAddonSubmissionPayload> = {};
  const failures: ComposerAddonLifecycleFailure[] = [];
  for (const [addonId, addon] of addons) {
    try {
      const payload = addon.readSubmissionPayload?.(targetKey) ?? null;
      if (payload !== null) payloads[addonId] = payload;
    } catch (error) {
      failures.push({ addonId, phase: "read", error });
    }
  }
  return { payloads, failures };
}

export function readComposerAddonSubmissionPayloads(
  targetKey: string,
): ComposerAddonSubmissionSnapshot {
  return readComposerAddonSubmissionPayloadsFrom(composerAddons, targetKey);
}

export async function clearComposerAddonSubmissionPayloadsFrom(
  addons: readonly ComposerAddonEntry[],
  targetKey: string,
  reason: "discarded" | "submitted",
): Promise<readonly ComposerAddonLifecycleFailure[]> {
  const snapshot = readComposerAddonSubmissionPayloadsFrom(addons, targetKey);
  const failures: ComposerAddonLifecycleFailure[] = [...snapshot.failures];
  for (const [addonId, addon] of addons) {
    const addonSnapshot = snapshot.payloads[addonId];
    if (addonSnapshot === undefined || addon.clearSubmissionPayload === undefined) continue;
    try {
      await addon.clearSubmissionPayload({
        targetKey,
        expectedRevision: addonSnapshot.revision,
        reason,
      });
    } catch (error) {
      failures.push({ addonId, phase: "clear", error });
    }
  }
  return failures;
}

export function clearComposerAddonSubmissionPayloads(
  targetKey: string,
  reason: "discarded" | "submitted" = "discarded",
): Promise<readonly ComposerAddonLifecycleFailure[]> {
  return clearComposerAddonSubmissionPayloadsFrom(composerAddons, targetKey, reason);
}

export async function commitComposerAddonSubmissionPayloadsFrom(
  addons: readonly ComposerAddonEntry[],
  input: {
    readonly targetKey: string;
    readonly threadRef: ScopedThreadRef;
    readonly payloads: Readonly<Record<string, ComposerAddonSubmissionPayload>>;
  },
): Promise<readonly ComposerAddonLifecycleFailure[]> {
  const failures: ComposerAddonLifecycleFailure[] = [];
  for (const [addonId, addon] of addons) {
    const snapshot = input.payloads[addonId];
    if (snapshot === undefined) continue;

    try {
      await addon.commitSubmission?.({
        targetKey: input.targetKey,
        threadRef: input.threadRef,
        revision: snapshot.revision,
        payload: snapshot.payload,
      });
    } catch (error) {
      failures.push({ addonId, phase: "commit", error });
      continue;
    }

    try {
      await addon.clearSubmissionPayload?.({
        targetKey: input.targetKey,
        expectedRevision: snapshot.revision,
        reason: "submitted",
      });
    } catch (error) {
      failures.push({ addonId, phase: "clear", error });
    }
  }
  return failures;
}

export function commitComposerAddonSubmissionPayloads(input: {
  readonly targetKey: string;
  readonly threadRef: ScopedThreadRef;
  readonly payloads: Readonly<Record<string, ComposerAddonSubmissionPayload>>;
}): Promise<readonly ComposerAddonLifecycleFailure[]> {
  return commitComposerAddonSubmissionPayloadsFrom(composerAddons, input);
}

export function useSidebarAddonThreadContributions(
  threads: readonly EnvironmentThreadShell[],
): readonly SidebarThreadAddonContribution[] {
  return sidebarAddons.flatMap(([addonId, addon]) => {
    const contributions: readonly SidebarThreadAddonContributionInput[] =
      addon.useThreadContributions(threads);
    assertUniqueContributionIds(
      addonId,
      contributions.map(
        (contribution) =>
          `${contribution.threadRef.environmentId}:${contribution.threadRef.threadId}:${contribution.contributionId}`,
      ),
    );
    return contributions.map((contribution) => ({ ...contribution, addonId }));
  });
}

export { ComposerAddonSlot, composerAddonBlockingIssue } from "./composer";
export type {
  ComposerAddon,
  ComposerAddonContext,
  ComposerAddonContribution,
  ComposerAddonContributionInput,
  ComposerAddonSubmissionPayload,
} from "./composer";
export { bundledWebAddons, validateWebAddons } from "./registry";
export type { WebAddon } from "./registry";
export { flattenSidebarAddonGroups, groupThreadsWithAddonContributions } from "./sidebar";
export type {
  SidebarAddon,
  SidebarThreadAddonContribution,
  SidebarThreadAddonContributionInput,
  SidebarThreadAddonGroup,
  SidebarThreadAddonMember,
  SidebarThreadAddonPresentation,
} from "./sidebar";
