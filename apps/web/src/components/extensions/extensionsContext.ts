// Fork: Kaluwa's Extensions page. What every part of the page reads.
import type {
  ExtensionKind,
  ExtensionsListResult,
  ExtensionsMutation,
  ExtensionsSubscription,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { createContext, use } from "react";

import type { ExtensionFixProblem } from "./extensionsFixPrompt";
import type { ExtensionEntry } from "./extensionsModel";

export type ExtensionsView =
  | { readonly page: "all" }
  | { readonly page: "attention" }
  | { readonly page: "library" }
  | { readonly page: "subscription"; readonly instanceId: ProviderInstanceId };

export interface ExtensionsAddPreset {
  readonly kind?: ExtensionKind;
  readonly instanceId?: ProviderInstanceId;
}

export interface ExtensionsContextValue {
  readonly list: ExtensionsListResult;
  readonly entries: readonly ExtensionEntry[];
  readonly search: string;
  /** False without permission to change provider config; changing controls are disabled. */
  readonly canEdit: boolean;
  /** A health check is running, so `unknown` means "not yet", not "never". */
  readonly checking: boolean;
  readonly isPending: (instanceId: ProviderInstanceId, entryKey: string) => boolean;
  /** Applies the changes in order and reports them in one toast. Resolves true when all worked. */
  readonly run: (mutations: readonly ExtensionsMutation[]) => Promise<boolean>;
  readonly recheck: () => void;
  readonly openView: (view: ExtensionsView) => void;
  readonly openDetail: (entryKey: string) => void;
  readonly openAdd: (preset?: ExtensionsAddPreset) => void;
  /** Starts a new thread that asks an agent to fix the problem, on that subscription. */
  readonly fixWithAi: (problem: ExtensionFixProblem, subscription: ExtensionsSubscription) => void;
}

export const ExtensionsContext = createContext<ExtensionsContextValue | null>(null);

export function useExtensions(): ExtensionsContextValue {
  const value = use(ExtensionsContext);
  if (value === null) throw new Error("useExtensions needs an ExtensionsContext");
  return value;
}

/** Subscriptions sharing a provider need their badge to be told apart. */
export function subscriptionNeedsBadge(
  subscriptions: readonly ExtensionsSubscription[],
  subscription: ExtensionsSubscription,
) {
  return subscriptions.some(
    (other) => other.instanceId !== subscription.instanceId && other.driver === subscription.driver,
  );
}
