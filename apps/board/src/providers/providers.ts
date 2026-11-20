import { defaultInstanceIdForDriver, type ServerProvider } from "@t3tools/contracts";

import type { OrchestratorSelection } from "../orchestrator/launch";

export type SignInState = "signed-in" | "signed-out" | "unknown";

export interface PickableModel {
  readonly slug: string;
  readonly name: string;
}

/** A Claude Code or Codex instance the engine reports, as the picker lists it. */
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
  readonly defaultModel: string | null;
}

/** What the picker holds: an instance and the model typed or chosen for it. */
export interface PickerValue {
  readonly instanceId: string;
  readonly model: string;
}

export const NO_PICK: PickerValue = { instanceId: "", model: "" };

const DRIVER_NAME = new Map([
  ["claudeAgent", "Claude Code"],
  ["codex", "Codex"],
]);
const DRIVER_ORDER = [...DRIVER_NAME.keys()];

const SIGN_IN = {
  authenticated: "signed-in",
  unauthenticated: "signed-out",
  unknown: "unknown",
} as const satisfies Record<ServerProvider["auth"]["status"], SignInState>;

/** The enabled Claude Code and Codex instances, Claude Code first, with each one's sign-in state and models. */
export function pickableInstances(
  providers: ReadonlyArray<ServerProvider>,
): ReadonlyArray<PickableInstance> {
  return providers
    .filter((provider) => provider.enabled && DRIVER_NAME.has(provider.driver))
    .toSorted(
      (left, right) =>
        DRIVER_ORDER.indexOf(left.driver) - DRIVER_ORDER.indexOf(right.driver) ||
        Number(right.instanceId === defaultInstanceIdForDriver(right.driver)) -
          Number(left.instanceId === defaultInstanceIdForDriver(left.driver)) ||
        left.instanceId.localeCompare(right.instanceId),
    )
    .map((provider) => {
      const models = provider.models.filter((model) => model.isLegacy !== true);
      return {
        instanceId: provider.instanceId,
        driver: provider.driver,
        name:
          provider.instanceId === defaultInstanceIdForDriver(provider.driver)
            ? (DRIVER_NAME.get(provider.driver) ?? provider.driver)
            : (provider.displayName ?? provider.instanceId),
        signIn: SIGN_IN[provider.auth.status],
        account: provider.auth.email ?? provider.auth.label ?? null,
        canSignIn: provider.setup?.canAuthenticate === true,
        unavailable: provider.installed ? null : "Not installed on the machine that runs T3",
        message: provider.message ?? null,
        models: models.map((model) => ({ slug: model.slug, name: model.name })),
        defaultModel: (models.find((model) => model.isDefault === true) ?? models[0])?.slug ?? null,
      };
    });
}

/** Whether an orchestrator can start on the instance now. An instance with an unknown sign-in is tried. */
export const canStart = (instance: PickableInstance) =>
  instance.unavailable === null && instance.signIn !== "signed-out";

/**
 * The pick, or while nothing is picked yet the first instance that can start, with its default
 * model unless one was typed.
 */
export function resolvePick(
  instances: ReadonlyArray<PickableInstance>,
  pick: PickerValue,
): PickerValue {
  if (instances.some((instance) => instance.instanceId === pick.instanceId)) return pick;
  const first = instances.find(canStart) ?? instances[0];
  return first === undefined
    ? pick
    : { instanceId: first.instanceId, model: pick.model || (first.defaultModel ?? "") };
}

/** The orchestrator's instance and model from the picker, with the typed model, or the default when it is empty. */
export function selectionOf(
  instances: ReadonlyArray<PickableInstance>,
  pick: PickerValue,
): OrchestratorSelection | null {
  const instance = instances.find((entry) => entry.instanceId === pick.instanceId);
  const model = pick.model.trim() || instance?.defaultModel;
  if (instance === undefined || !model) return null;
  return {
    instanceId: instance.instanceId,
    driver: instance.driver,
    model,
    offered: instance.models.map((entry) => entry.slug),
  };
}
