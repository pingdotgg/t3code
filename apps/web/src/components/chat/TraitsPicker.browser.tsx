import "../../index.css";

import {
  type ModelSelection,
  ClaudeModelOptions,
  CodexModelOptions,
  DEFAULT_MODEL_BY_PROVIDER,
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  type ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import { page } from "vitest/browser";
import { useCallback } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { TraitsPicker } from "./TraitsPicker";
import {
  COMPOSER_DRAFT_STORAGE_KEY,
  ComposerThreadDraftState,
  useComposerDraftStore,
  useComposerThreadDraft,
  useEffectiveComposerModelState,
} from "../../composerDraftStore";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";

// ── Claude TraitsPicker tests ─────────────────────────────────────────

const CLAUDE_THREAD_ID = ThreadId.makeUnsafe("thread-claude-traits");
const TEST_PROVIDERS: ReadonlyArray<ServerProvider> = [
  {
    provider: "codex",
    enabled: true,
    installed: true,
    version: "0.1.0",
    status: "ready",
    authStatus: "authenticated",
    checkedAt: "2026-01-01T00:00:00.000Z",
    models: [
      {
        slug: "gpt-5.4",
        name: "GPT-5.4",
        isCustom: false,
        capabilities: {
          reasoningEffortLevels: [
            { value: "xhigh", label: "Extra High" },
            { value: "high", label: "High", isDefault: true },
          ],
          supportsFastMode: true,
          supportsThinkingToggle: false,
          contextWindowOptions: [],
          promptInjectedEffortLevels: [],
        },
      },
    ],
  },
  {
    provider: "claudeAgent",
    enabled: true,
    installed: true,
    version: "0.1.0",
    status: "ready",
    authStatus: "authenticated",
    checkedAt: "2026-01-01T00:00:00.000Z",
    models: [
      {
        slug: "claude-opus-4-6",
        name: "Claude Opus 4.6",
        isCustom: false,
        capabilities: {
          reasoningEffortLevels: [
            { value: "low", label: "Low" },
            { value: "medium", label: "Medium" },
            { value: "high", label: "High", isDefault: true },
            { value: "max", label: "Max" },
            { value: "ultrathink", label: "Ultrathink" },
          ],
          supportsFastMode: true,
          supportsThinkingToggle: false,
          contextWindowOptions: [],
          promptInjectedEffortLevels: ["ultrathink"],
        },
      },
      {
        slug: "claude-sonnet-4-6",
        name: "Claude Sonnet 4.6",
        isCustom: false,
        capabilities: {
          reasoningEffortLevels: [
            { value: "low", label: "Low" },
            { value: "medium", label: "Medium" },
            { value: "high", label: "High", isDefault: true },
            { value: "ultrathink", label: "Ultrathink" },
          ],
          supportsFastMode: false,
          supportsThinkingToggle: false,
          contextWindowOptions: [],
          promptInjectedEffortLevels: ["ultrathink"],
        },
      },
      {
        slug: "claude-haiku-4-5",
        name: "Claude Haiku 4.5",
        isCustom: false,
        capabilities: {
          reasoningEffortLevels: [],
          supportsFastMode: false,
          supportsThinkingToggle: true,
          contextWindowOptions: [],
          promptInjectedEffortLevels: [],
        },
      },
    ],
  },
];

function ClaudeTraitsPickerHarness(props: {
  model: string;
  fallbackModelSelection: ModelSelection | null;
  triggerVariant?: "ghost" | "outline";
}) {
  const prompt = useComposerThreadDraft(CLAUDE_THREAD_ID).prompt;
  const setPrompt = useComposerDraftStore((store) => store.setPrompt);
  const { modelOptions, selectedModel } = useEffectiveComposerModelState({
    threadId: CLAUDE_THREAD_ID,
    providers: TEST_PROVIDERS,
    selectedProvider: "claudeAgent",
    threadModelSelection: props.fallbackModelSelection,
    projectModelSelection: null,
    settings: {
      ...DEFAULT_SERVER_SETTINGS,
      ...DEFAULT_CLIENT_SETTINGS,
    },
  });
  const handlePromptChange = useCallback(
    (nextPrompt: string) => {
      setPrompt(CLAUDE_THREAD_ID, nextPrompt);
    },
    [setPrompt],
  );

  return (
    <TraitsPicker
      provider="claudeAgent"
      models={TEST_PROVIDERS[1]!.models}
      threadId={CLAUDE_THREAD_ID}
      model={selectedModel ?? props.model}
      prompt={prompt}
      modelOptions={modelOptions?.claudeAgent}
      onPromptChange={handlePromptChange}
      triggerVariant={props.triggerVariant}
    />
  );
}

async function mountClaudePicker(props?: {
  model?: string;
  prompt?: string;
  options?: ClaudeModelOptions;
  fallbackModelOptions?: {
    effort?: "low" | "medium" | "high" | "max" | "ultrathink";
    thinking?: boolean;
    fastMode?: boolean;
  } | null;
  skipDraftModelOptions?: boolean;
  triggerVariant?: "ghost" | "outline";
}) {
  const model = props?.model ?? "claude-opus-4-6";
  const claudeOptions = !props?.skipDraftModelOptions ? props?.options : undefined;
  const draftsByThreadId: Record<ThreadId, ComposerThreadDraftState> = {
    [CLAUDE_THREAD_ID]: {
      prompt: props?.prompt ?? "",
      images: [],
      nonPersistedImageIds: [],
      persistedAttachments: [],
      terminalContexts: [],
      modelSelectionByProvider: props?.skipDraftModelOptions
        ? {}
        : {
            claudeAgent: {
              provider: "claudeAgent",
              model,
              ...(claudeOptions && Object.keys(claudeOptions).length > 0
                ? { options: claudeOptions }
                : {}),
            },
          },
      activeProvider: "claudeAgent",
      runtimeMode: null,
      interactionMode: null,
    },
  };
  useComposerDraftStore.setState({
    draftsByThreadId,
    draftThreadsByThreadId: {},
    projectDraftThreadIdByProjectId: {},
  });
  const host = document.createElement("div");
  document.body.append(host);
  const fallbackModelSelection =
    props?.fallbackModelOptions !== undefined
      ? ({
          provider: "claudeAgent",
          model,
          ...(props.fallbackModelOptions ? { options: props.fallbackModelOptions } : {}),
        } satisfies ModelSelection)
      : null;
  const screen = await render(
    <ClaudeTraitsPickerHarness
      model={model}
      fallbackModelSelection={fallbackModelSelection}
      {...(props?.triggerVariant ? { triggerVariant: props.triggerVariant } : {})}
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

describe("TraitsPicker (Claude)", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    useComposerDraftStore.setState({
      draftsByThreadId: {},
      draftThreadsByThreadId: {},
      projectDraftThreadIdByProjectId: {},
      stickyModelSelectionByProvider: {},
    });
  });

  it("shows fast mode controls for Opus", async () => {
    await using _ = await mountClaudePicker();

    await page.getByRole("button").click();

    await vi.waitFor(() => {
      const text = document.body.textContent ?? "";
      expect(text).toContain("Fast Mode");
      expect(text).toContain("off");
      expect(text).toContain("on");
    });
  });

  it("hides fast mode controls for non-Opus models", async () => {
    await using _ = await mountClaudePicker({ model: "claude-sonnet-4-6" });

    await page.getByRole("button").click();

    await vi.waitFor(() => {
      expect(document.body.textContent ?? "").not.toContain("Fast Mode");
    });
  });

  it("shows only the provided effort options", async () => {
    await using _ = await mountClaudePicker({
      model: "claude-sonnet-4-6",
    });

    await page.getByRole("button").click();

    await vi.waitFor(() => {
      const text = document.body.textContent ?? "";
      expect(text).toContain("Low");
      expect(text).toContain("Medium");
      expect(text).toContain("High");
      expect(text).not.toContain("Max");
      expect(text).toContain("Ultrathink");
    });
  });

  it("shows a th  inking on/off dropdown for Haiku", async () => {
    await using _ = await mountClaudePicker({
      model: "claude-haiku-4-5",
      options: { thinking: true },
    });

    await vi.waitFor(() => {
      expect(document.body.textContent ?? "").toContain("Thinking On");
    });
    await page.getByRole("button").click();

    await vi.waitFor(() => {
      const text = document.body.textContent ?? "";
      expect(text).toContain("Thinking");
      expect(text).toContain("On (default)");
      expect(text).toContain("Off");
    });
  });

  it("shows prompt-controlled Ultrathink state with disabled effort controls", async () => {
    await using _ = await mountClaudePicker({
      model: "claude-opus-4-6",
      options: { effort: "high" },
      prompt: "Ultrathink:\nInvestigate this",
    });

    await vi.waitFor(() => {
      expect(document.body.textContent ?? "").toContain("Ultrathink");
      expect(document.body.textContent ?? "").not.toContain("Ultrathink · Prompt");
    });
    await page.getByRole("button").click();

    await vi.waitFor(() => {
      const text = document.body.textContent ?? "";
      expect(text).toContain("Effort");
      expect(text).toContain("Remove Ultrathink from the prompt to change effort.");
      expect(text).not.toContain("Fallback Effort");
    });
  });

  it("persists sticky claude model options when traits change", async () => {
    await using _ = await mountClaudePicker({
      model: "claude-opus-4-6",
      options: { effort: "medium", fastMode: false },
    });

    await page.getByRole("button").click();
    await page.getByRole("menuitemradio", { name: "Max" }).click();

    expect(
      useComposerDraftStore.getState().stickyModelSelectionByProvider.claudeAgent,
    ).toMatchObject({
      provider: "claudeAgent",
      options: {
        effort: "max",
      },
    });
  });

  it("accepts outline trigger styling", async () => {
    await using _ = await mountClaudePicker({
      triggerVariant: "outline",
    });

    const button = document.querySelector("button");
    if (!(button instanceof HTMLButtonElement)) {
      throw new Error("Expected traits trigger button to be rendered.");
    }
    expect(button.className).toContain("border-input");
    expect(button.className).toContain("bg-popover");
  });
});

// ── Codex TraitsPicker tests ──────────────────────────────────────────

async function mountCodexPicker(props: { model?: string; options?: CodexModelOptions }) {
  const threadId = ThreadId.makeUnsafe("thread-codex-traits");
  const model = props.model ?? DEFAULT_MODEL_BY_PROVIDER.codex;
  const draftsByThreadId: Record<ThreadId, ComposerThreadDraftState> = {
    [threadId]: {
      prompt: "",
      images: [],
      nonPersistedImageIds: [],
      persistedAttachments: [],
      terminalContexts: [],
      modelSelectionByProvider: {
        codex: {
          provider: "codex",
          model,
          ...(props.options ? { options: props.options } : {}),
        },
      },
      activeProvider: "codex",
      runtimeMode: null,
      interactionMode: null,
    },
  };

  useComposerDraftStore.setState({
    draftsByThreadId,
    draftThreadsByThreadId: {},
    projectDraftThreadIdByProjectId: {
      [ProjectId.makeUnsafe("project-codex-traits")]: threadId,
    },
  });
  const host = document.createElement("div");
  document.body.append(host);
  const screen = await render(
    <TraitsPicker
      provider="codex"
      models={TEST_PROVIDERS[0]!.models}
      threadId={threadId}
      model={props.model ?? DEFAULT_MODEL_BY_PROVIDER.codex}
      prompt=""
      modelOptions={props.options}
      onPromptChange={() => {}}
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

describe("TraitsPicker (Codex)", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    localStorage.removeItem(COMPOSER_DRAFT_STORAGE_KEY);
    useComposerDraftStore.setState({
      draftsByThreadId: {},
      draftThreadsByThreadId: {},
      projectDraftThreadIdByProjectId: {},
      stickyModelSelectionByProvider: {},
    });
  });

  it("shows fast mode controls", async () => {
    await using _ = await mountCodexPicker({
      options: { fastMode: false },
    });

    await page.getByRole("button").click();

    await vi.waitFor(() => {
      const text = document.body.textContent ?? "";
      expect(text).toContain("Fast Mode");
      expect(text).toContain("off");
      expect(text).toContain("on");
    });
  });

  it("shows Fast in the trigger label when fast mode is active", async () => {
    await using _ = await mountCodexPicker({
      options: { fastMode: true },
    });

    await vi.waitFor(() => {
      expect(document.body.textContent ?? "").toContain("High · Fast");
    });
  });

  it("shows only the provided effort options", async () => {
    await using _ = await mountCodexPicker({
      options: { fastMode: false },
    });

    await page.getByRole("button").click();

    await vi.waitFor(() => {
      const text = document.body.textContent ?? "";
      expect(text).toContain("Extra High");
      expect(text).toContain("High");
      expect(text).not.toContain("Low");
      expect(text).not.toContain("Medium");
    });
  });

  it("persists sticky codex model options when traits change", async () => {
    await using _ = await mountCodexPicker({
      options: { fastMode: false },
    });

    await page.getByRole("button").click();
    await page.getByRole("menuitemradio", { name: "on" }).click();

    expect(useComposerDraftStore.getState().stickyModelSelectionByProvider.codex).toMatchObject({
      provider: "codex",
      options: { fastMode: true },
    });
  });
});
