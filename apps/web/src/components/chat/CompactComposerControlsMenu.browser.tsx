import {
  DEFAULT_MODEL_BY_PROVIDER,
  EnvironmentId,
  ModelSelection,
  ThreadId,
} from "@t3tools/contracts";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime";
import "../../index.css";

import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { createModelCapabilities, createModelSelection } from "@t3tools/shared/model";

import { CompactComposerControlsMenu } from "./CompactComposerControlsMenu";
import { TraitsMenuContent } from "./TraitsPicker";
import { useComposerDraftStore } from "../../composerDraftStore";

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
  const provider = props?.modelSelection?.provider ?? "claudeAgent";
  const model = props?.modelSelection?.model ?? DEFAULT_MODEL_BY_PROVIDER[provider];

  useComposerDraftStore.setState({
    draftsByThreadKey: {
      [threadKey]: {
        prompt: props?.prompt ?? "",
        images: [],
        nonPersistedImageIds: [],
        persistedAttachments: [],
        terminalContexts: [],
        modelSelectionByProvider: {
          [provider]: createModelSelection(provider, model, props?.modelSelection?.options),
        },
        activeProvider: provider,
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
      modelSelection: createModelSelection("claudeAgent", "claude-opus-4-6"),
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
      modelSelection: createModelSelection("claudeAgent", "claude-sonnet-4-6"),
    });

    await page.getByLabelText("More composer controls").click();

    await vi.waitFor(() => {
      expect(document.body.textContent ?? "").not.toContain("Fast Mode");
    });
  });

  it("shows only the provided effort options", async () => {
    await using _ = await mountMenu({
      modelSelection: createModelSelection("claudeAgent", "claude-sonnet-4-6"),
    });

    await page.getByLabelText("More composer controls").click();

    await vi.waitFor(() => {
      const text = document.body.textContent ?? "";
      expect(text).toContain("Low");
      expect(text).toContain("Medium");
      expect(text).toContain("High");
      expect(text).not.toContain("Max");
      expect(text).toContain("Ultrathink");
    });
  });

  it("shows a Claude thinking on/off section for Haiku", async () => {
    await using _ = await mountMenu({
      modelSelection: createModelSelection("claudeAgent", "claude-haiku-4-5", [
        { id: "thinking", value: true },
      ]),
    });

    await page.getByLabelText("More composer controls").click();

    await vi.waitFor(() => {
      const text = document.body.textContent ?? "";
      expect(text).toContain("Thinking");
      expect(text).toContain("On");
      expect(text).toContain("Off");
    });
  });

  it("shows prompt-controlled Ultrathink state with selectable effort controls", async () => {
    await using _ = await mountMenu({
      modelSelection: createModelSelection("claudeAgent", "claude-opus-4-6", [
        { id: "effort", value: "high" },
      ]),
      prompt: "Ultrathink:\nInvestigate this",
    });

    await page.getByLabelText("More composer controls").click();

    await vi.waitFor(() => {
      const text = document.body.textContent ?? "";
      expect(text).toContain("Reasoning");
      expect(text).not.toContain("ultrathink");
    });
  });

  it("warns when ultrathink appears in prompt body text", async () => {
    await using _ = await mountMenu({
      modelSelection: createModelSelection("claudeAgent", "claude-opus-4-6", [
        { id: "effort", value: "high" },
      ]),
      prompt: "Ultrathink:\nplease ultrathink about this problem",
    });

    await page.getByLabelText("More composer controls").click();

    await vi.waitFor(() => {
      const text = document.body.textContent ?? "";
      expect(text).toContain(
        'Your prompt contains "ultrathink" in the text. Remove it to change this option.',
      );
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
});
