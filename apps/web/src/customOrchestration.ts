import { minuteTick } from "@t3tools/client-runtime/clock";
import {
  customOrchestrationCommandNameProblem,
  type CustomOrchestrationSettings,
  type ModelSelection,
  type ProjectId,
  type ProviderDriverKind,
  type ServerProvider,
} from "@t3tools/contracts";
import type { UnifiedSettings } from "@t3tools/contracts/settings";
import {
  customOrchestrationModelProblem,
  resolveCustomOrchestrationModel,
  type CustomOrchestrationModelProblem,
} from "@t3tools/shared/customOrchestration";
import { msg } from "gt-react";
import { useSyncExternalStore } from "react";

import { m, type MessageResolver } from "~/i18n/messages";
import type { ProviderInstanceEntry } from "./providerInstances";

export type OrchestrationModelProblem =
  | CustomOrchestrationModelProblem
  | { readonly kind: "locked" }
  | { readonly kind: "disabled"; readonly reason: string };

/** The configured model's display name, or its id while its provider does not list it. */
export function orchestrationModelName(
  entries: ReadonlyArray<ProviderInstanceEntry>,
  selection: ModelSelection,
): string {
  const entry = entries.find((entry) => entry.instanceId === selection.instanceId);
  return entry?.models.find((model) => model.slug === selection.model)?.name ?? selection.model;
}

export function orchestrationProblemText(
  problem: OrchestrationModelProblem,
  model: string,
  resolve: MessageResolver = m,
): string {
  switch (problem.kind) {
    case "provider":
      return resolve(msg("The provider of {model} is unavailable.", { model }));
    case "model":
      return resolve(msg("{model} is unavailable.", { model }));
    case "limit":
      return resolve(msg("{model} is at its usage limit.", { model }));
    case "locked":
      return resolve(msg("This thread cannot switch to {model}.", { model }));
    case "disabled":
      return problem.reason;
  }
}

export interface ComposerOrchestrator {
  /**
   * The model a send runs on: the orchestrator or its first fallback that can run. With none, the
   * orchestrator, so the composer can still name it. Null while none is configured.
   */
  readonly selection: ModelSelection | null;
  /** Why a Custom Orchestration thread cannot send, or null when a configured model can run it. */
  readonly blockReason: string | null;
  /** Set while a fallback runs in the orchestrator's place. */
  readonly standingIn: {
    readonly primary: ModelSelection;
    readonly problem: OrchestrationModelProblem;
  } | null;
}

export function composerOrchestrator(input: {
  readonly settings: UnifiedSettings;
  readonly entries: ReadonlyArray<ProviderInstanceEntry>;
  readonly projectId: ProjectId | null;
  readonly now: number;
  readonly lockedProvider: ProviderDriverKind | null;
  readonly lockedContinuationGroupKey: string | null;
  readonly modelDisabledReason?: (
    instanceId: ModelSelection["instanceId"],
    model: string,
  ) => string | null;
  readonly resolve?: MessageResolver;
}): ComposerOrchestrator {
  const resolve = input.resolve ?? m;
  const configured = input.settings.customOrchestration.orchestrator;
  if (configured === null) {
    return {
      selection: null,
      blockReason: resolve(msg("Choose an orchestrator model in Settings → Orchestration.")),
      standingIn: null,
    };
  }
  const providers = input.entries.map((entry) => entry.snapshot);
  const problemOf = (selection: ModelSelection): OrchestrationModelProblem | null => {
    const problem = customOrchestrationModelProblem(selection, {
      providers,
      now: input.now,
      settings: input.settings,
      projectId: input.projectId,
    });
    // A usage limit passes, so anything else that rules a model out is reported ahead of it.
    if (problem !== null && problem.kind !== "limit") return problem;
    const entry = input.entries.find((entry) => entry.instanceId === selection.instanceId);
    if (
      input.lockedProvider !== null &&
      entry !== undefined &&
      (entry.driverKind !== input.lockedProvider ||
        (input.lockedContinuationGroupKey !== null &&
          entry.continuationGroupKey !== input.lockedContinuationGroupKey))
    ) {
      return { kind: "locked" };
    }
    const reason = input.modelDisabledReason?.(selection.instanceId, selection.model) ?? null;
    return reason === null ? problem : { kind: "disabled", reason };
  };
  const { selection, skipped } = resolveCustomOrchestrationModel(configured, problemOf);
  const primary = configured.modelSelection;
  const primaryProblem = skipped[0]?.selection === primary ? (skipped[0]?.problem ?? null) : null;
  if (selection !== null) {
    return {
      selection,
      blockReason: null,
      standingIn:
        selection === primary || primaryProblem === null
          ? null
          : { primary, problem: primaryProblem },
    };
  }
  const blockReason =
    primaryProblem?.kind === "disabled"
      ? primaryProblem.reason
      : primaryProblem?.kind === "locked"
        ? resolve(
            msg("This thread cannot switch to the orchestrator's provider. Start a new thread."),
          )
        : primaryProblem?.kind === "model"
          ? resolve(
              msg(
                "The orchestrator model {model} is unavailable. Check Settings → Orchestration.",
                {
                  model: primary.model,
                },
              ),
            )
          : resolve(
              msg("The orchestrator's provider is unavailable. Check Settings → Orchestration."),
            );
  return { selection: primary, blockReason, standingIn: null };
}

/** A clock for usage limit resets that ticks only while an orchestrator is configured. */
export function useOrchestrationNow(active: boolean): number {
  const minute = useSyncExternalStore(
    active ? minuteTick.subscribe : subscribeNothing,
    minuteTick.getSnapshot,
    minuteTick.getSnapshot,
  );
  return Date.parse(`${minute}:00Z`);
}

const subscribeNothing = () => () => {};

/** The slash menu of a Custom Orchestration thread: the user's commands, then the provider's. */
export function withCustomOrchestrationCommands(
  providerCommands: ServerProvider["slashCommands"],
  settings: CustomOrchestrationSettings,
  resolve: MessageResolver = m,
): ServerProvider["slashCommands"] {
  const custom = settings.commands
    .filter(
      (command) =>
        command.reviewers.length > 0 &&
        customOrchestrationCommandNameProblem(command.name) === null,
    )
    .map((command) => ({
      name: command.name,
      description: resolve(
        msg("{count, plural, one {Review by {count} model} other {Review by {count} models}}", {
          count: command.reviewers.length,
        }),
      ),
    }));
  if (custom.length === 0) return providerCommands;
  const names = new Set(custom.map((command) => command.name));
  return [...custom, ...providerCommands.filter((command) => !names.has(command.name))];
}
