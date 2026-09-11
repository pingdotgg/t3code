import {
  resolveProviderAccountSwitchPrompt,
  retainConfirmedAccountSwitch,
} from "@t3tools/client-runtime/state/provider-instance-display";
import type { ProviderAccountSwitchCandidate } from "@t3tools/client-runtime/state/provider-instance-display";
import type { ModelSelection, ProviderInstanceId } from "@t3tools/contracts";

/** Enough of a thread to tell whether it owns a provider conversation. */
export interface ThreadAccountLock {
  readonly modelSelection: ModelSelection;
  readonly session: {
    readonly providerInstanceId?: ProviderInstanceId | undefined;
    readonly providerAccountRevision?: number | undefined;
  } | null;
  readonly latestTurn: unknown | null;
  readonly latestUserMessageAt: string | null;
}

/** Stopped or imported threads still own their provider conversation. */
export function resolveThreadAccountLock(
  thread: ThreadAccountLock | null | undefined,
): ProviderInstanceId | undefined {
  if (!thread) return undefined;
  const started =
    thread.session !== null || thread.latestTurn !== null || thread.latestUserMessageAt !== null;
  if (!started) return undefined;
  return thread.session?.providerInstanceId ?? thread.modelSelection.instanceId;
}

/** Offer the owning account and accounts the user can confirm switching to. */
export function selectThreadProviderGroups<Group extends { readonly providerKey: string }>(input: {
  readonly groups: ReadonlyArray<Group>;
  readonly lockedInstanceId: ProviderInstanceId | undefined;
  readonly providers: ReadonlyArray<ProviderAccountSwitchCandidate>;
  readonly accountSwitchSupported: boolean;
}): ReadonlyArray<Group> {
  const { lockedInstanceId } = input;
  if (lockedInstanceId === undefined) return input.groups;
  const current = input.providers.find((provider) => provider.instanceId === lockedInstanceId);
  return input.groups.filter(
    (group) =>
      group.providerKey === lockedInstanceId ||
      resolveProviderAccountSwitchPrompt({
        supported: input.accountSwitchSupported,
        current,
        next: input.providers.find((provider) => provider.instanceId === group.providerKey),
      }) !== null,
  );
}

/** A same-provider account switch the user confirmed, until the next turn starts it. */
export interface ConfirmedAccountSwitch {
  readonly threadKey: string;
  readonly from: ProviderInstanceId;
  readonly to: ProviderInstanceId;
  readonly revision: number;
}

/** Persisted drafts may change accounts only while the matching consent is still valid. */
export function resolveComposerModelSelection(input: {
  readonly draftSelection: ModelSelection | null | undefined;
  readonly threadSelection: ModelSelection;
  readonly threadKey: string;
  readonly lockedInstanceId: ProviderInstanceId | undefined;
  readonly confirmedSwitch: ConfirmedAccountSwitch | null;
  readonly providerAccountRevision?: number | undefined;
}): ModelSelection {
  const { draftSelection, threadSelection, lockedInstanceId } = input;
  if (lockedInstanceId === undefined) return draftSelection ?? threadSelection;
  const confirmed = retainConfirmedAccountSwitch(
    input.confirmedSwitch,
    lockedInstanceId,
    input.providerAccountRevision,
  );
  for (const selection of [draftSelection, threadSelection]) {
    if (
      selection &&
      (selection.instanceId === lockedInstanceId ||
        (confirmed !== null &&
          confirmed.threadKey === input.threadKey &&
          confirmed.to === selection.instanceId))
    ) {
      return selection;
    }
  }
  // Metadata can name the target before a switch succeeds. Keep the owner.
  return { ...threadSelection, instanceId: lockedInstanceId };
}
