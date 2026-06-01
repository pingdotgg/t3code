import {
  DEFAULT_MODEL,
  DEFAULT_MODEL_BY_PROVIDER,
  EnvironmentId,
  ModelSelection,
  type ProviderOptionDescriptor,
  ProviderInstanceId,
  ProviderDriverKind,
  ThreadId,
} from "@t3tools/contracts";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime";
import "../../index.css";

import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { createModelCapabilities, createModelSelection } from "@t3tools/shared/model";

import { CompactComposerControlsMenu } from "./CompactComposerControlsMenu";
import { isReasoningDescriptor, TraitsMenuContent } from "./TraitsPicker";
import { useComposerDraftStore } from "../../composerDraftStore";

// The compact "more controls" menu mirrors the app: the reasoning-effort
// control is promoted to its own picker, so it is filtered out here.
const withoutReasoning = (descriptor: ProviderOptionDescriptor) =>
  !isReasoningDescriptor(descriptor);

const LOCAL_ENVIRONMENT_ID = EnvironmentId.make("environment-local");

function selectDescriptor(
  id: string,
  label: string,
  options: ReadonlyArray<{ id: string; label: string; isDefault?: boolean }>,
  promptInjectedValues?: ReadonlyArray<string>,
) {
  return {
    id,
    label,
    type: "select" as const,
    options: [...options],
    ...(options.find((option) => option.isDefault)?.id
      ? { currentValue: options.find((option) => option.isDefault)?.id }
      : {}),
    ...(promptInjectedValues && promptInjectedValues.length > 0
      ? { promptInjectedValues: [...promptInjectedValues] }
      : {}),
  };
}

function booleanDescriptor(id: string, label: string) {
  return {
    id,
    label,
    type: "boolean" as const,
  };
}

async function mountMenu(props?: { modelSelection?: ModelSelection; prompt?: string }) {
  const threadId = ThreadId.make("thread-compact-menu");
  const threadRef = scopeThreadRef(LOCAL_ENVIRONMENT_ID, threadId);
  const threadKey = scopedThreadKey(threadRef);
  const provider = ProviderDriverKind.make("claudeAgent");
  const instanceId = ProviderInstanceId.make(props?.modelSelection?.instanceId ?? provider);
  const model =
    props?.modelSelection?.model ?? DEFAULT_MODEL_BY_PROVIDER[provider] ?? DEFAULT_MODEL;

  useComposerDraftStore.setState({
    draftsByThreadKey: {
      [threadKey]: {
        prompt: props?.prompt ?? "",
        images: [],
        nonPersistedImageIds: [],
        persistedAttachments: [],
        terminalContexts: [],
        modelSelectionByProvider: {
          [instanceId]: createModelSelection(instanceId, model, props?.modelSelection?.options),
        },
        activeProvider: instanceId,
        runtimeMode: null,
        interactionMode: null,
      },
    },
    draftThreadsByThreadKey: {},
    logicalProjectDraftThreadKeyByLogicalProjectKey: {},
  });
  const host = document.createElement("div");
  document.body.append(host);
  const onPromptChange = vi.fn();
  const providerOptions = props?.modelSelection?.options;
  const models = [
    {
      slug: "claude-opus-4-6",
      name: "Claude Opus 4.6",
      isCustom: false,
      capabilities: createModelCapabilities({
        optionDescriptors: [
          selectDescriptor(
            "effort",
            "Reasoning",
            [
              { id: "low", label: "Low" },
              { id: "medium", label: "Medium" },
              { id: "high", label: "High", isDefault: true },
              { id: "max", label: "Max" },
              { id: "ultrathink", label: "Ultrathink" },
            ],
            ["ultrathink"],
          ),
          booleanDescriptor("fastMode", "Fast Mode"),
        ],
      }),
    },
    {
      slug: "claude-haiku-4-5",
      name: "Claude Haiku 4.5",
      isCustom: false,
      capabilities: createModelCapabilities({
        optionDescriptors: [booleanDescriptor("thinking", "Thinking")],
      }),
    },
    {
      slug: "claude-sonnet-4-6",
      name: "Claude Sonnet 4.6",
      isCustom: false,
      capabilities: createModelCapabilities({
        optionDescriptors: [
          selectDescriptor(
            "effort",
            "Reasoning",
            [
              { id: "low", label: "Low" },
              { id: "medium", label: "Medium" },
              { id: "high", label: "High", isDefault: true },
              { id: "ultrathink", label: "Ultrathink" },
            ],
            ["ultrathink"],
          ),
        ],
      }),
    },
  ];
  const screen = await render(
    <CompactComposerControlsMenu
      activePlan={false}
      interactionMode="default"
      planSidebarLabel="Plan"
      planSidebarOpen={false}
      runtimeMode="approval-required"
      showInteractionModeToggle
      traitsMenuContent={
        <TraitsMenuContent
          provider={provider}
          models={models}
          threadRef={threadRef}
          model={model}
          prompt={props?.prompt ?? ""}
          modelOptions={providerOptions}
          onPromptChange={onPromptChange}
          descriptorFilter={withoutReasoning}
        />
      }
      onToggleInteractionMode={vi.fn()}
      onTogglePlanSidebar={vi.fn()}
      onRuntimeModeChange={vi.fn()}
    />,
    { container: host },
  );

  const cleanup = async () => {
    await screen.unmount();
    host.remove();
  };

  return {
    [Symbol.asyncDispose]: cleanup,
    cleanup,
  };
}

describe("CompactComposerControlsMenu", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    useComposerDraftStore.setState({
      draftsByThreadKey: {},
      draftThreadsByThreadKey: {},
      logicalProjectDraftThreadKeyByLogicalProjectKey: {},
      stickyModelSelectionByProvider: {},
    });
  });

  it("shows fast mode controls for Opus", async () => {
    await using _ = await mountMenu({
      modelSelection: createModelSelection(
        ProviderInstanceId.make("claudeAgent"),
        "claude-opus-4-6",
      ),
    });

    await page.getByLabelText("More composer controls").click();

    await vi.waitFor(() => {
      const text = document.body.textContent ?? "";
      expect(text).toContain("Fast Mode");
      expect(text).toContain("On");
      expect(text).toContain("Off");
    });
  });

  it("hides fast mode controls for non-Opus Claude models", async () => {
    await using _ = await mountMenu({
      modelSelection: createModelSelection(
        ProviderInstanceId.make("claudeAgent"),
        "claude-sonnet-4-6",
      ),
    });

    await page.getByLabelText("More composer controls").click();

    await vi.waitFor(() => {
      expect(document.body.textContent ?? "").not.toContain("Fast Mode");
    });
  });

  it("omits the reasoning-effort control (it lives in its own picker)", async () => {
    await using _ = await mountMenu({
      modelSelection: createModelSelection(
        ProviderInstanceId.make("claudeAgent"),
        "claude-opus-4-6",
      ),
    });

    await page.getByLabelText("More composer controls").click();

    await vi.waitFor(() => {
      const text = document.body.textContent ?? "";
      // Reasoning section header and its options are absent; Fast Mode remains.
      expect(text).not.toContain("Reasoning");
      expect(text).not.toContain("Ultrathink");
      expect(text).toContain("Fast Mode");
    });
  });

  it("shows a Claude thinking on/off section for Haiku", async () => {
    await using _ = await mountMenu({
      modelSelection: createModelSelection(
        ProviderInstanceId.make("claudeAgent"),
        "claude-haiku-4-5",
        [{ id: "thinking", value: true }],
      ),
    });

    await page.getByLabelText("More composer controls").click();

    await vi.waitFor(() => {
      const text = document.body.textContent ?? "";
      expect(text).toContain("Thinking");
      expect(text).toContain("On");
      expect(text).toContain("Off");
    });
  });

  it("can hide the interaction mode section", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const screen = await render(
      <CompactComposerControlsMenu
        activePlan={false}
        interactionMode="default"
        planSidebarLabel="Plan"
        planSidebarOpen={false}
        runtimeMode="approval-required"
        showInteractionModeToggle={false}
        onToggleInteractionMode={vi.fn()}
        onTogglePlanSidebar={vi.fn()}
        onRuntimeModeChange={vi.fn()}
      />,
      { container: host },
    );

    await page.getByLabelText("More composer controls").click();

    await vi.waitFor(() => {
      const text = document.body.textContent ?? "";
      expect(text).not.toContain("Mode");
      expect(text).not.toContain("Chat");
      expect(text).not.toContain("Plan");
      expect(text).toContain("Access");
      expect(text).toContain("Supervised");
      expect(text).toContain("Full access");
    });

    await screen.unmount();
    host.remove();
  });

  it("shows the Codex auto review switch in the Access section when available", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const onAutoReviewChange = vi.fn();
    const screen = await render(
      <CompactComposerControlsMenu
        activePlan={false}
        interactionMode="default"
        planSidebarLabel="Plan"
        planSidebarOpen={false}
        runtimeMode="approval-required"
        showInteractionModeToggle={false}
        autoReviewAvailable
        autoReviewEnabled={false}
        onToggleInteractionMode={vi.fn()}
        onTogglePlanSidebar={vi.fn()}
        onRuntimeModeChange={vi.fn()}
        onAutoReviewChange={onAutoReviewChange}
      />,
      { container: host },
    );

    await page.getByLabelText("More composer controls").click();

    await vi.waitFor(() => {
      const text = document.body.textContent ?? "";
      expect(text).toContain("Access");
      expect(text).toContain("Auto Review");
    });

    await page.getByText("Auto Review").click();

    await vi.waitFor(() => {
      expect(onAutoReviewChange).toHaveBeenCalledWith(true);
    });

    await screen.unmount();
    host.remove();
  });
});
