import "../../index.css";

import {
  type ModelSelection,
  ClaudeModelOptions,
  CodexModelOptions,
  CursorModelOptions,
  DEFAULT_MODEL_BY_PROVIDER,
  DEFAULT_SERVER_SETTINGS,
  OpenCodeModelOptions,
  EnvironmentId,
  type ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime";
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

const LOCAL_ENVIRONMENT_ID = EnvironmentId.make("environment-local");
const CLAUDE_THREAD_ID = ThreadId.make("thread-claude-traits");
const CLAUDE_THREAD_REF = scopeThreadRef(LOCAL_ENVIRONMENT_ID, CLAUDE_THREAD_ID);
const CLAUDE_THREAD_KEY = scopedThreadKey(CLAUDE_THREAD_REF);
const CODEX_THREAD_ID = ThreadId.make("thread-codex-traits");
const CODEX_THREAD_REF = scopeThreadRef(LOCAL_ENVIRONMENT_ID, CODEX_THREAD_ID);
const CODEX_THREAD_KEY = scopedThreadKey(CODEX_THREAD_REF);
const TEST_PROVIDERS: ReadonlyArray<ServerProvider> = [
  {
    provider: "codex",
    enabled: true,
    installed: true,
    version: "0.1.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-01-01T00:00:00.000Z",
    slashCommands: [],
    skills: [],
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
    provider: "opencode",
    enabled: true,
    installed: true,
    version: "0.1.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-01-01T00:00:00.000Z",
    slashCommands: [],
    skills: [],
    models: [
      {
        slug: "openai/gpt-5",
        name: "GPT-5",
        isCustom: false,
        capabilities: {
          reasoningEffortLevels: [],
          supportsFastMode: false,
          supportsThinkingToggle: false,
          contextWindowOptions: [],
          promptInjectedEffortLevels: [],
          variantOptions: [
            { value: "low", label: "Low" },
            { value: "medium", label: "Medium", isDefault: true },
          ],
          agentOptions: [
            { value: "build", label: "Build", isDefault: true },
            { value: "plan", label: "Plan" },
          ],
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
    auth: { status: "authenticated" },
    checkedAt: "2026-01-01T00:00:00.000Z",
    slashCommands: [],
    skills: [],
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
const findTestProvider = (provider: ServerProvider["provider"]) => {
  const testProvider = TEST_PROVIDERS.find((candidate) => candidate.provider === provider);
  if (!testProvider) {
    throw new Error(`Missing test provider fixture: ${provider}`);
  }
  return testProvider;
};

function ClaudeTraitsPickerHarness(props: {
  model: string;
  fallbackModelSelection: ModelSelection | null;
  triggerVariant?: "ghost" | "outline";
}) {
  const prompt = useComposerThreadDraft(CLAUDE_THREAD_REF).prompt;
  const setPrompt = useComposerDraftStore((store) => store.setPrompt);
  const { modelOptions, selectedModel } = useEffectiveComposerModelState({
    threadRef: CLAUDE_THREAD_REF,
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
      setPrompt(CLAUDE_THREAD_REF, nextPrompt);
    },
    [setPrompt],
  );

  return (
    <TraitsPicker
      provider="claudeAgent"
      models={TEST_PROVIDERS[2]!.models}
      threadRef={CLAUDE_THREAD_REF}
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
  const draftsByThreadKey: Record<string, ComposerThreadDraftState> = {
    [CLAUDE_THREAD_KEY]: {
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
    draftsByThreadKey,
    draftThreadsByThreadKey: {},
    logicalProjectDraftThreadKeyByLogicalProjectKey: {},
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
      draftsByThreadKey: {},
      draftThreadsByThreadKey: {},
      logicalProjectDraftThreadKeyByLogicalProjectKey: {},
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

  it("shows prompt-controlled Ultrathink state with selectable effort controls", async () => {
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
      expect(text).not.toContain("ultrathink");
    });
  });

  it("warns when ultrathink appears in prompt body text", async () => {
    await using _ = await mountClaudePicker({
      model: "claude-opus-4-6",
      options: { effort: "high" },
      prompt: "Ultrathink:\nplease ultrathink about this problem",
    });

    await page.getByRole("button").click();

    await vi.waitFor(() => {
      const text = document.body.textContent ?? "";
      expect(text).toContain(
        'Your prompt contains "ultrathink" in the text. Remove it to change effort.',
      );
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
  const model = props.model ?? DEFAULT_MODEL_BY_PROVIDER.codex;
  const draftsByThreadKey: Record<string, ComposerThreadDraftState> = {
    [CODEX_THREAD_KEY]: {
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
    draftsByThreadKey,
    draftThreadsByThreadKey: {},
    logicalProjectDraftThreadKeyByLogicalProjectKey: {
      "environment-local:project-codex-traits": CODEX_THREAD_KEY,
    },
  });
  const host = document.createElement("div");
  document.body.append(host);
  const screen = await render(
    <TraitsPicker
      provider="codex"
      models={TEST_PROVIDERS[0]!.models}
      threadRef={CODEX_THREAD_REF}
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

async function mountCursorPicker(props: { model?: string; options?: CursorModelOptions }) {
  const model = props.model ?? DEFAULT_MODEL_BY_PROVIDER.cursor;
  const cursorThreadId = ThreadId.make("thread-cursor-traits");
  const cursorThreadRef = scopeThreadRef(LOCAL_ENVIRONMENT_ID, cursorThreadId);
  const cursorThreadKey = scopedThreadKey(cursorThreadRef);
  const host = document.createElement("div");
  document.body.append(host);

  useComposerDraftStore.setState({
    draftsByThreadKey: {
      [cursorThreadKey]: {
        prompt: "",
        images: [],
        nonPersistedImageIds: [],
        persistedAttachments: [],
        terminalContexts: [],
        modelSelectionByProvider: {
          cursor: {
            provider: "cursor",
            model,
            ...(props.options ? { options: props.options } : {}),
          },
        },
        activeProvider: "cursor",
        runtimeMode: null,
        interactionMode: null,
      },
    },
    draftThreadsByThreadKey: {},
    logicalProjectDraftThreadKeyByLogicalProjectKey: {},
  });

  const screen = await render(
    <TraitsPicker
      provider="cursor"
      models={[
        {
          slug: "composer-2",
          name: "Composer 2",
          isCustom: false,
          capabilities: {
            reasoningEffortLevels: [],
            supportsFastMode: true,
            supportsThinkingToggle: false,
            contextWindowOptions: [],
            promptInjectedEffortLevels: [],
          },
        },
        {
          slug: "claude-opus-4-6",
          name: "Opus 4.6",
          isCustom: false,
          capabilities: {
            reasoningEffortLevels: [],
            supportsFastMode: true,
            supportsThinkingToggle: false,
            contextWindowOptions: [
              { value: "200k", label: "200K", isDefault: true },
              { value: "1m", label: "1M" },
            ],
            promptInjectedEffortLevels: [],
          },
        },
      ]}
      threadRef={cursorThreadRef}
      model={model}
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
      draftsByThreadKey: {},
      draftThreadsByThreadKey: {},
      logicalProjectDraftThreadKeyByLogicalProjectKey: {},
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

// ── OpenCode TraitsPicker tests ───────────────────────────────────────

async function mountOpenCodePicker(props: {
  model?: string;
  options?: OpenCodeModelOptions;
  models?: ServerProvider["models"];
}) {
  const threadId = ThreadId.make("thread-opencode-traits");
  const threadRef = scopeThreadRef(LOCAL_ENVIRONMENT_ID, threadId);
  const threadKey = scopedThreadKey(threadRef);
  const model = props.model ?? DEFAULT_MODEL_BY_PROVIDER.opencode;
  const draftsByThreadKey: Record<string, ComposerThreadDraftState> = {
    [threadKey]: {
      prompt: "",
      images: [],
      nonPersistedImageIds: [],
      persistedAttachments: [],
      terminalContexts: [],
      modelSelectionByProvider: {
        opencode: {
          provider: "opencode",
          model,
          ...(props.options ? { options: props.options } : {}),
        },
      },
      activeProvider: "opencode",
      runtimeMode: null,
      interactionMode: null,
    },
  };

  useComposerDraftStore.setState({
    draftsByThreadKey,
    draftThreadsByThreadKey: {},
    logicalProjectDraftThreadKeyByLogicalProjectKey: {},
  });
  const host = document.createElement("div");
  document.body.append(host);
  const screen = await render(
    <TraitsPicker
      provider="opencode"
      models={props.models ?? findTestProvider("opencode").models}
      threadRef={threadRef}
      model={model}
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

describe("TraitsPicker (OpenCode)", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    localStorage.removeItem(COMPOSER_DRAFT_STORAGE_KEY);
    useComposerDraftStore.setState({
      draftsByThreadKey: {},
      draftThreadsByThreadKey: {},
      logicalProjectDraftThreadKeyByLogicalProjectKey: {},
      stickyModelSelectionByProvider: {},
    });
  });

  it("shows the selected agent label with capitalization in the trigger", async () => {
    await using _ = await mountOpenCodePicker({
      options: {
        variant: "medium",
        agent: "plan",
      },
    });

    await vi.waitFor(() => {
      const text = document.body.textContent ?? "";
      expect(text).toContain("Medium · Plan");
      expect(text).not.toContain("Medium · plan");
    });
  });

  it("does not show a leading separator when only agent options are available", async () => {
    await using _ = await mountOpenCodePicker({
      model: "openai/gpt-5.4",
      models: [
        {
          slug: "openai/gpt-5.4",
          name: "OpenAI · GPT-5.4",
          isCustom: false,
          capabilities: {
            reasoningEffortLevels: [],
            supportsFastMode: false,
            supportsThinkingToggle: false,
            contextWindowOptions: [],
            promptInjectedEffortLevels: [],
            variantOptions: [],
            agentOptions: [
              { value: "build", label: "Build", isDefault: true },
              { value: "plan", label: "Plan" },
            ],
          },
        },
      ],
    });

    await page.getByRole("button").click();

    await vi.waitFor(() => {
      const text = document.body.textContent ?? "";
      expect(text).toContain("Agent");
      expect(text).toContain("Build (default)");
      expect(text).toContain("Plan");
      expect(document.querySelectorAll('[data-slot="menu-separator"]')).toHaveLength(0);
    });
  });
});

describe("TraitsPicker (Cursor)", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    localStorage.removeItem(COMPOSER_DRAFT_STORAGE_KEY);
    useComposerDraftStore.setState({
      draftsByThreadKey: {},
      draftThreadsByThreadKey: {},
      logicalProjectDraftThreadKeyByLogicalProjectKey: {},
      stickyModelSelectionByProvider: {},
    });
  });

  it("uses the selected fast mode menu label for the trigger in fast-only state", async () => {
    await using _ = await mountCursorPicker({
      model: "composer-2",
      options: { fastMode: false },
    });

    await vi.waitFor(() => {
      const text = document.body.textContent ?? "";
      expect(text).toContain("Normal");
    });

    await page.getByRole("button").click();

    await vi.waitFor(() => {
      const text = document.body.textContent ?? "";
      expect(text).toContain("Fast Mode");
      expect(text).toContain("off");
      expect(text).toContain("on");
    });
  });

  it("shows Normal for Cursor Opus 4.6 when fast mode and context window are both at defaults", async () => {
    await using _ = await mountCursorPicker({
      model: "claude-opus-4-6",
      options: { fastMode: false },
    });

    await vi.waitFor(() => {
      const text = document.body.textContent ?? "";
      expect(text).toContain("Normal");
    });

    await page.getByRole("button").click();

    await vi.waitFor(() => {
      const text = document.body.textContent ?? "";
      expect(text).toContain("Fast Mode");
      expect(text).toContain("Context Window");
      expect(text).toContain("200K (default)");
      expect(text).toContain("1M");
    });
  });

  it("shows Normal · 1M for Cursor Opus 4.6 when fast mode is off and context window is overridden", async () => {
    await using _ = await mountCursorPicker({
      model: "claude-opus-4-6",
      options: { fastMode: false, contextWindow: "1m" },
    });

    await vi.waitFor(() => {
      expect(document.body.textContent ?? "").toContain("Normal · 1M");
    });
  });
});
