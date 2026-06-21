import { assert, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";

import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import { decideProviderSessionTransition } from "./ProviderSessionTransitionPolicy.ts";

const driver = ProviderDriverKind.make("codex");
const instanceId = ProviderInstanceId.make("codex");
const base = {
  driver,
  continuationIdentity: { driverKind: driver, continuationKey: "codex:account:one" },
  modelSelection: { instanceId, model: "gpt-5.1-codex" },
  runtimeMode: "full-access" as const,
  interactionMode: "default" as const,
  workspace: "/repo",
  capabilities: CodexProviderCapabilitiesV2,
};

it("reuses compatible sessions and treats interaction mode as turn-scoped", () => {
  assert.deepEqual(
    decideProviderSessionTransition({
      current: base,
      target: { ...base, interactionMode: "plan", available: true },
    }),
    { type: "reuse" },
  );
});

it("switches models in-session only when supported", () => {
  assert.deepEqual(
    decideProviderSessionTransition({
      current: base,
      target: {
        ...base,
        modelSelection: { ...base.modelSelection, model: "gpt-5.2-codex" },
        available: true,
      },
    }),
    { type: "switch_model_in_session" },
  );
  assert.deepEqual(
    decideProviderSessionTransition({
      current: {
        ...base,
        capabilities: {
          ...base.capabilities,
          sessions: { ...base.capabilities.sessions, supportsModelSwitchInSession: false },
        },
      },
      target: {
        ...base,
        capabilities: {
          ...base.capabilities,
          sessions: { ...base.capabilities.sessions, supportsModelSwitchInSession: false },
        },
        modelSelection: { ...base.modelSelection, model: "gpt-5.2-codex" },
        available: true,
      },
    }),
    { type: "restart_and_resume" },
  );
});

it("restarts compatible instances for workspace or runtime changes", () => {
  assert.deepEqual(
    decideProviderSessionTransition({
      current: base,
      target: { ...base, workspace: "/other", available: true },
    }),
    { type: "restart_and_resume" },
  );
});

it("uses portable handoff for incompatible continuation identities", () => {
  assert.deepEqual(
    decideProviderSessionTransition({
      current: base,
      target: {
        ...base,
        modelSelection: {
          ...base.modelSelection,
          instanceId: ProviderInstanceId.make("codex_other"),
        },
        continuationIdentity: { driverKind: driver, continuationKey: "codex:account:other" },
        available: true,
      },
    }),
    { type: "create_with_handoff" },
  );
});
