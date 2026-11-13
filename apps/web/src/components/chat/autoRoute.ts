import {
  ProviderInstanceId,
  type ModelSelection,
  type ProviderDriverKind,
} from "@t3tools/contracts";
import { resolveAutoModelSelection } from "@t3tools/shared/autoModel";

import type { ProviderInstanceEntry } from "../../providerInstances";
import { getTriggerDisplayModelName } from "./providerIconUtils";

/** What the `auto` model would run as right now, for labels such as "Auto · Opus 5.5 (B)". */
export interface AutoRoute {
  readonly driverKind: ProviderDriverKind;
  /** The concrete model and its account, such as "Opus 5.5 (B)". */
  readonly label: string;
}

/**
 * Mirrors the server's routing (same resolver, same live usage snapshots), so the picker shows
 * the model a new message would get. The server still decides per message; a thread already on
 * a model may stay on it.
 */
export function describeAutoRoute(input: {
  readonly entries: ReadonlyArray<ProviderInstanceEntry>;
  readonly options?: ModelSelection["options"];
  readonly now: number;
}): AutoRoute | null {
  const resolution = resolveAutoModelSelection({
    selection: {
      instanceId: ProviderInstanceId.make("auto"),
      model: "auto",
      ...(input.options ? { options: input.options } : {}),
    },
    providers: input.entries.map((entry) => entry.snapshot),
    now: input.now,
  });
  if (!resolution) return null;
  const entry = input.entries.find(
    (candidate) => candidate.instanceId === resolution.selection.instanceId,
  );
  const model = entry?.models.find((candidate) => candidate.slug === resolution.selection.model);
  if (!entry || !model) return null;
  // Claude instances are named "Auto" (account A) and "Auto B"; other providers keep their name.
  const account =
    entry.driverKind === "claudeAgent"
      ? /\bB$/.test(entry.displayName)
        ? "B"
        : "A"
      : entry.displayName;
  return {
    driverKind: entry.driverKind,
    label: `${getTriggerDisplayModelName(model, entry.driverKind)} (${account})`,
  };
}
