import {
  isReasoningSelect,
  selectableProviderOptionChoices,
} from "@t3tools/client-runtime/model-traits";
import {
  defaultInstanceIdForDriver,
  type ModelSelection,
  ProviderInstanceId,
  type ProviderOptionSelection,
  type ServerProvider,
} from "@t3tools/contracts";

import type { OrchestratorSelection } from "../orchestrator/launch";

export type SignInState = "signed-in" | "signed-out" | "unknown";

/** The model's reasoning control, with the levels the picker lists. */
export interface EffortControl {
  /** The option id a model selection carries the level under. */
  readonly id: string;
  readonly choices: ReadonlyArray<{ readonly id: string; readonly label: string }>;
  readonly defaultChoice: string | null;
}

export interface PickableModel {
  readonly slug: string;
  readonly name: string;
  readonly effort: EffortControl | null;
}

/** Where a new orchestrator starts: Claude Code on this model at this effort. */
export const DEFAULT_ORCHESTRATOR = { model: "claude-opus-5-5", effort: "medium" } as const;

/** A Claude Code instance the engine reports, as the picker lists it. */
export interface PickableInstance {
  readonly instanceId: string;
  readonly driver: string;
  readonly name: string;
  readonly signIn: SignInState;
  /** The account the instance is signed in as. */
  readonly account: string | null;
  /** Whether the engine can run a sign-in for this instance. Claude Code signs in on the machine that runs T3. */
  readonly canSignIn: boolean;
  /** Why the instance cannot start an orchestrator, or null. */
  readonly unavailable: string | null;
  /** What the engine says about the instance, such as how to sign in outside T3. */
  readonly message: string | null;
  readonly models: ReadonlyArray<PickableModel>;
  /** Every model the instance runs, legacy ones too, though the picker lists only `models`. A role may name a legacy model. */
  readonly offered: ReadonlyArray<string>;
  readonly defaultModel: string | null;
}

/** What the picker holds: an instance, the model typed or chosen for it, and its effort, empty for the model's own default. */
export interface PickerValue {
  readonly instanceId: string;
  readonly model: string;
  readonly effort: string;
}

export const NO_PICK: PickerValue = { instanceId: "", model: "", effort: "" };

function effortControl(model: ServerProvider["models"][number]): EffortControl | null {
  const descriptor = model.capabilities?.optionDescriptors?.find(isReasoningSelect);
  if (descriptor === undefined) return null;
  return {
    id: descriptor.id,
    choices: selectableProviderOptionChoices(descriptor).map(({ id, label }) => ({ id, label })),
    defaultChoice: descriptor.options.find((option) => option.isDefault === true)?.id ?? null,
  };
}

const CLAUDE_CODE = "Claude Code";

const SIGN_IN = {
  authenticated: "signed-in",
  unauthenticated: "signed-out",
  unknown: "unknown",
} as const satisfies Record<ServerProvider["auth"]["status"], SignInState>;

/** The enabled Claude Code instances with each one's sign-in state and models. */
export function pickableInstances(
  providers: ReadonlyArray<ServerProvider>,
): ReadonlyArray<PickableInstance> {
  return providers
    .filter((provider) => provider.enabled && provider.driver === "claudeAgent")
    .toSorted((left, right) => left.instanceId.localeCompare(right.instanceId))
    .map((provider) => {
      const models = provider.models.filter((model) => model.isLegacy !== true);
      return {
        instanceId: provider.instanceId,
        driver: provider.driver,
        name:
          provider.instanceId === defaultInstanceIdForDriver(provider.driver)
            ? CLAUDE_CODE
            : (provider.displayName ?? provider.instanceId),
        signIn: SIGN_IN[provider.auth.status],
        account: provider.auth.email ?? provider.auth.label ?? null,
        canSignIn: provider.setup?.canAuthenticate === true,
        unavailable: provider.installed ? null : "Not installed on the machine that runs T3",
        message: provider.message ?? null,
        offered: provider.models.map((model) => model.slug),
        models: models.map((model) => ({
          slug: model.slug,
          name: model.name,
          effort: effortControl(model),
        })),
        defaultModel: (models.find((model) => model.isDefault === true) ?? models[0])?.slug ?? null,
      };
    });
}

/** Whether an orchestrator can start on the instance now. An instance with an unknown sign-in is tried. */
export const canStart = (instance: PickableInstance) =>
  instance.unavailable === null && instance.signIn !== "signed-out";

export interface DefaultPick {
  readonly value: PickerValue;
  /** Why the default is not Claude Code on its usual model, or null. */
  readonly reason: string | null;
}

const instanceIsSignedIn = (instance: PickableInstance) =>
  instance.unavailable === null && instance.signIn === "signed-in";

/**
 * Where a new orchestrator starts. Claude Code on its default model at medium effort when a
 * signed-in Claude instance offers it. Otherwise the first signed-in instance on its default model,
 * with the reason shown under the picker.
 */
export function defaultPick(instances: ReadonlyArray<PickableInstance>): DefaultPick {
  const preferred = instances.find(
    (instance) =>
      instanceIsSignedIn(instance) &&
      instance.models.some((model) => model.slug === DEFAULT_ORCHESTRATOR.model),
  );
  if (preferred !== undefined) {
    return {
      value: {
        instanceId: preferred.instanceId,
        model: DEFAULT_ORCHESTRATOR.model,
        effort: DEFAULT_ORCHESTRATOR.effort,
      },
      reason: null,
    };
  }
  const fallback = instances.find(instanceIsSignedIn) ?? instances.find(canStart) ?? instances[0];
  const lead = instances[0];
  if (fallback === undefined || lead === undefined) return { value: NO_PICK, reason: null };
  const why = instances.some(instanceIsSignedIn)
    ? `Claude Code does not offer ${DEFAULT_ORCHESTRATOR.model}.`
    : `Claude Code is ${lead.unavailable === null ? "signed out" : "not installed"}.`;
  return {
    value: { instanceId: fallback.instanceId, model: fallback.defaultModel ?? "", effort: "" },
    reason: `${why} Starting on ${fallback.name} instead.`,
  };
}

/** The pick, or while nothing is picked yet the default, with a model typed before any pick kept. */
export function resolvePick(
  instances: ReadonlyArray<PickableInstance>,
  pick: PickerValue,
): PickerValue {
  if (instances.some((instance) => instance.instanceId === pick.instanceId)) return pick;
  const { value } = defaultPick(instances);
  return pick.model === "" ? value : { ...value, model: pick.model, effort: "" };
}

/** The effort control of the picked model, when the instance lists the model and it has one. */
export function effortOf(
  instances: ReadonlyArray<PickableInstance>,
  pick: PickerValue,
): EffortControl | null {
  const instance = instances.find((entry) => entry.instanceId === pick.instanceId);
  const model = pick.model.trim() || instance?.defaultModel;
  return instance?.models.find((entry) => entry.slug === model)?.effort ?? null;
}

/** The orchestrator's instance, model, and effort from the picker, with the typed model, or the default when it is empty. */
export function selectionOf(
  instances: ReadonlyArray<PickableInstance>,
  pick: PickerValue,
): OrchestratorSelection | null {
  const instance = instances.find((entry) => entry.instanceId === pick.instanceId);
  const model = pick.model.trim() || instance?.defaultModel;
  if (instance === undefined || !model) return null;
  const control = effortOf(instances, pick);
  const options: ReadonlyArray<ProviderOptionSelection> =
    control !== null && pick.effort !== "" ? [{ id: control.id, value: pick.effort }] : [];
  return {
    instanceId: instance.instanceId,
    driver: instance.driver,
    model,
    offered: instance.offered,
    options,
  };
}

/** The picker's value for a thread's current model selection. */
export function pickOf(
  instances: ReadonlyArray<PickableInstance>,
  selection: ModelSelection,
): PickerValue {
  const instance = instances.find((entry) => entry.instanceId === selection.instanceId);
  const control = instance?.models.find((entry) => entry.slug === selection.model)?.effort;
  const chosen =
    control === null || control === undefined
      ? undefined
      : (selection.options ?? []).find((option) => option.id === control.id)?.value;
  return { instanceId: selection.instanceId, model: selection.model, effort: String(chosen ?? "") };
}

/** The model selection a turn goes out with, or null when the pick names no instance or model. */
export function modelSelectionOf(
  instances: ReadonlyArray<PickableInstance>,
  pick: PickerValue,
): ModelSelection | null {
  const selection = selectionOf(instances, pick);
  if (selection === null) return null;
  return {
    instanceId: ProviderInstanceId.make(selection.instanceId),
    model: selection.model,
    ...(selection.options.length > 0 ? { options: selection.options } : {}),
  };
}
