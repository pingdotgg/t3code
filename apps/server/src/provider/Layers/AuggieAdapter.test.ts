import { describe, expect, it } from "@effect/vitest";

import {
  isAuggieIndexingPermissionRequest,
  isAuggieSessionMissingFailure,
  resolveRequestedModeId,
  selectDeclinedPermissionOption,
} from "./AuggieAdapter.ts";
import { buildAuggieModelsFromSessionModelState } from "./AuggieProvider.ts";

const AUGGIE_MODES = {
  currentModeId: "default",
  availableModes: [
    {
      id: "default",
      name: "Default",
      description: "Agent mode: Full access to modify and interact with code",
    },
    { id: "ask", name: "Ask", description: "Ask a question: Get answers without modifying code" },
  ],
};

describe("resolveRequestedModeId", () => {
  it("maps T3 plan mode onto Auggie's non-editing Ask mode", () => {
    expect(resolveRequestedModeId({ interactionMode: "plan", modeState: AUGGIE_MODES })).toBe(
      "ask",
    );
  });

  it("keeps the editing mode when T3 is not planning", () => {
    expect(resolveRequestedModeId({ interactionMode: undefined, modeState: AUGGIE_MODES })).toBe(
      "default",
    );
    expect(resolveRequestedModeId({ interactionMode: "default", modeState: AUGGIE_MODES })).toBe(
      "default",
    );
  });

  it("never picks a non-editing mode as the implement target", () => {
    // Auggie has no approval-only mode, so supervision stays with T3 and the
    // session must remain able to edit.
    const resolved = resolveRequestedModeId({
      interactionMode: undefined,
      modeState: { currentModeId: "ask", availableModes: AUGGIE_MODES.availableModes },
    });
    expect(resolved).toBe("default");
  });

  it("requests no mode change when the agent advertises none", () => {
    expect(
      resolveRequestedModeId({ interactionMode: "plan", modeState: undefined }),
    ).toBeUndefined();
  });
});

describe("isAuggieSessionMissingFailure", () => {
  it("recognizes the load failure for a session Auggie never persisted", () => {
    expect(
      isAuggieSessionMissingFailure({
        code: -32602,
        message: "Invalid params",
      }),
    ).toBe(false);
    expect(
      isAuggieSessionMissingFailure({
        code: -32602,
        message: "Session not found: 0656db16-de53-4587-ad0d-2eda75469f5a",
      }),
    ).toBe(true);
  });

  it("does not swallow unrelated protocol failures", () => {
    expect(isAuggieSessionMissingFailure({ code: -32603, message: "Internal error" })).toBe(false);
    expect(isAuggieSessionMissingFailure(undefined)).toBe(false);
    expect(isAuggieSessionMissingFailure("Session not found")).toBe(false);
  });
});

describe("buildAuggieModelsFromSessionModelState", () => {
  it("marks the session's current model as the default choice", () => {
    const models = buildAuggieModelsFromSessionModelState({
      currentModelId: "claude-opus-5",
      availableModels: [
        { modelId: "butler_a", name: "Prism (Claude + GPT)" },
        { modelId: "claude-opus-5", name: "Claude Opus 5" },
      ],
    });

    expect(models.map((model) => model.slug)).toEqual(["butler_a", "claude-opus-5"]);
    expect(models.find((model) => model.slug === "claude-opus-5")?.isDefault).toBe(true);
    expect(models.find((model) => model.slug === "butler_a")?.isDefault).toBeUndefined();
  });

  it("returns nothing when the agent advertised no catalog", () => {
    expect(buildAuggieModelsFromSessionModelState(undefined)).toEqual([]);
    expect(
      buildAuggieModelsFromSessionModelState({ currentModelId: "", availableModels: [] }),
    ).toEqual([]);
  });

  it("falls back to the model id when the agent sends a blank name", () => {
    const models = buildAuggieModelsFromSessionModelState({
      currentModelId: "claude-opus-5",
      availableModels: [{ modelId: "claude-opus-5", name: "   " }],
    });
    expect(models[0]?.name).toBe("claude-opus-5");
  });
});

// Captured verbatim from `auggie --acp` 0.34.0 on the first `session/new` of a
// workspace it has not indexed.
const INDEXING_PERMISSION_REQUEST = {
  sessionId: "f227dcc5-8bac-4921-81d8-c0a79ec095a9",
  toolCall: {
    toolCallId: "workspace-indexing-permission",
    title: "Workspace Indexing Permission",
  },
  options: [
    { optionId: "always-enable", name: "Always index", kind: "allow_always" },
    { optionId: "always-disable", name: "Never index", kind: "reject_always" },
    { optionId: "session-enable", name: "Index for this session", kind: "allow_once" },
    { optionId: "session-disable", name: "Skip for this session", kind: "reject_once" },
  ],
} as const;

describe("isAuggieIndexingPermissionRequest", () => {
  it("recognizes the consent request Auggie raises during session setup", () => {
    expect(isAuggieIndexingPermissionRequest(INDEXING_PERMISSION_REQUEST)).toBe(true);
  });

  it("leaves ordinary tool approvals to the user", () => {
    expect(
      isAuggieIndexingPermissionRequest({
        ...INDEXING_PERMISSION_REQUEST,
        toolCall: { toolCallId: "write-file-1", title: "Write file" },
      }),
    ).toBe(false);
  });
});

describe("selectDeclinedPermissionOption", () => {
  it("declines for this session rather than writing a persistent refusal", () => {
    // `always-disable` would persist "never index" into the user's own Auggie
    // config, which is not T3's to change.
    expect(selectDeclinedPermissionOption(INDEXING_PERMISSION_REQUEST)).toBe("session-disable");
  });

  it("reports no option when the agent offers no single-turn refusal", () => {
    expect(
      selectDeclinedPermissionOption({
        ...INDEXING_PERMISSION_REQUEST,
        options: [{ optionId: "always-disable", name: "Never index", kind: "reject_always" }],
      }),
    ).toBeUndefined();
  });
});
