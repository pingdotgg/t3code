import {
  EnvironmentId,
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

import { isReasoningDescriptor, TraitsPicker } from "./TraitsPicker";
import { useComposerDraftStore } from "../../composerDraftStore";

const LOCAL_ENVIRONMENT_ID = EnvironmentId.make("environment-local");

// Mirrors the compact composer: the standalone reasoning picker only renders
// the reasoning-effort control.
const reasoningOnly = (descriptor: ProviderOptionDescriptor) => isReasoningDescriptor(descriptor);

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

const MODELS = [
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
            { id: "ultrathink", label: "Ultrathink" },
          ],
          ["ultrathink"],
        ),
        { id: "fastMode", label: "Fast Mode", type: "boolean" as const },
      ],
    }),
  },
];

async function mountReasoningPicker(props?: {
  model?: string;
  prompt?: string;
  options?: ReadonlyArray<{ id: string; value: string | boolean }>;
}) {
  const threadId = ThreadId.make("thread-reasoning-picker");
  const threadRef = scopeThreadRef(LOCAL_ENVIRONMENT_ID, threadId);
  const threadKey = scopedThreadKey(threadRef);
  const provider = ProviderDriverKind.make("claudeAgent");
  const instanceId = ProviderInstanceId.make("claudeAgent");
  const model = props?.model ?? "claude-opus-4-6";

  useComposerDraftStore.setState({
    draftsByThreadKey: {
      [threadKey]: {
        prompt: props?.prompt ?? "",
        images: [],
        nonPersistedImageIds: [],
        persistedAttachments: [],
        terminalContexts: [],
        modelSelectionByProvider: {
          [instanceId]: createModelSelection(instanceId, model, props?.options),
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
  const screen = await render(
    <TraitsPicker
      provider={provider}
      models={MODELS}
      threadRef={threadRef}
      model={model}
      prompt={props?.prompt ?? ""}
      modelOptions={props?.options}
      onPromptChange={onPromptChange}
      descriptorFilter={reasoningOnly}
    />,
    { container: host },
  );

  const cleanup = async () => {
    await screen.unmount();
    host.remove();
  };

  return { onPromptChange, cleanup, [Symbol.asyncDispose]: cleanup };
}

describe("reasoning effort picker", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    useComposerDraftStore.setState({
      draftsByThreadKey: {},
      draftThreadsByThreadKey: {},
      logicalProjectDraftThreadKeyByLogicalProjectKey: {},
      stickyModelSelectionByProvider: {},
    });
  });

  it("shows only the reasoning-effort options, not sibling traits", async () => {
    await using _ = await mountReasoningPicker();

    await page.getByRole("button").click();

    await vi.waitFor(() => {
      const text = document.body.textContent ?? "";
      expect(text).toContain("Low");
      expect(text).toContain("Medium");
      expect(text).toContain("High");
      expect(text).toContain("Ultrathink");
      // Sibling traits stay in the "more controls" menu, not here.
      expect(text).not.toContain("Fast Mode");
    });
  });

  it("warns when ultrathink appears in prompt body text", async () => {
    await using _ = await mountReasoningPicker({
      options: [{ id: "effort", value: "high" }],
      prompt: "Ultrathink:\nplease ultrathink about this problem",
    });

    await page.getByRole("button").click();

    await vi.waitFor(() => {
      const text = document.body.textContent ?? "";
      expect(text).toContain(
        'Your prompt contains "ultrathink" in the text. Remove it to change this option.',
      );
    });
  });
});
