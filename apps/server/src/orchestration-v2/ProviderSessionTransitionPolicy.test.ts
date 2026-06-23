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

it("uses the adapter's selection transition classification", () => {
  assert.deepEqual(
    decideProviderSessionTransition({
      current: base,
      target: {
        ...base,
        modelSelection: { ...base.modelSelection, model: "gpt-5.2-codex" },
        available: true,
      },
      selectionTransition: { type: "apply_on_next_turn" },
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
      selectionTransition: { type: "restart_session" },
    }),
    { type: "restart_and_resume" },
  );
});

it("treats provider option changes as selection changes", () => {
  assert.deepEqual(
    decideProviderSessionTransition({
      current: {
        ...base,
        modelSelection: {
          ...base.modelSelection,
          options: [{ id: "reasoningEffort", value: "medium" }],
        },
      },
      target: {
        ...base,
        modelSelection: {
          ...base.modelSelection,
          options: [{ id: "reasoningEffort", value: "high" }],
        },
        available: true,
      },
      selectionTransition: { type: "apply_on_next_turn" },
    }),
    { type: "switch_model_in_session" },
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

it("uses portable handoff for cross-driver transitions", () => {
  const claudeDriver = ProviderDriverKind.make("claude");
  assert.deepEqual(
    decideProviderSessionTransition({
      current: base,
      target: {
        ...base,
        driver: claudeDriver,
        continuationIdentity: { driverKind: claudeDriver, continuationKey: "claude:account:one" },
        modelSelection: {
          instanceId: ProviderInstanceId.make("claude"),
          model: "claude-opus-4-1",
        },
        available: true,
      },
    }),
    { type: "create_with_handoff" },
  );
});
