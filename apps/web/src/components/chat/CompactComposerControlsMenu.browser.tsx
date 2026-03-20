import { type ProviderModelOptions, ThreadId } from "@t3tools/contracts";
import "../../index.css";

import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { CompactComposerControlsMenu } from "./CompactComposerControlsMenu";
import { ClaudeTraitsMenuContent } from "./ClaudeTraitsPicker";
import { CodexTraitsMenuContent } from "./CodexTraitsPicker";
import { useComposerDraftStore } from "../../composerDraftStore";

async function mountMenu(props?: {
  model?: string;
  prompt?: string;
  provider?: "codex" | "claudeAgent";
  modelOptions?: ProviderModelOptions | null;
}) {
  const threadId = ThreadId.makeUnsafe("thread-compact-menu");
  const provider = props?.provider ?? "claudeAgent";
  const draftsByThreadId = {} as ReturnType<
    typeof useComposerDraftStore.getState
  >["draftsByThreadId"];
  draftsByThreadId[threadId] = {
    prompt: props?.prompt ?? "",
    images: [],
    nonPersistedImageIds: [],
    persistedAttachments: [],
    terminalContexts: [],
    provider,
    model: props?.model ?? "claude-opus-4-6",
    modelOptions: props?.modelOptions ?? null,
    runtimeMode: null,
    interactionMode: null,
  };
  useComposerDraftStore.setState({
    draftsByThreadId,
    draftThreadsByThreadId: {},
    projectDraftThreadIdByProjectId: {},
  });
  const host = document.createElement("div");
  document.body.append(host);
  const onPromptChange = vi.fn();
  const screen = await render(
    <CompactComposerControlsMenu
      activePlan={false}
      interactionMode="default"
      planSidebarOpen={false}
      runtimeMode="approval-required"
      traitsMenuContent={
        provider === "codex" ? (
          <CodexTraitsMenuContent threadId={threadId} />
        ) : (
          <ClaudeTraitsMenuContent
            threadId={threadId}
            model={props?.model ?? "claude-opus-4-6"}
            onPromptChange={onPromptChange}
          />
        )
      }
      onToggleInteractionMode={vi.fn()}
      onTogglePlanSidebar={vi.fn()}
      onToggleRuntimeMode={vi.fn()}
    />,
    { container: host },
  );

  return {
    cleanup: async () => {
      await screen.unmount();
      host.remove();
    },
  };
}

describe("CompactComposerControlsMenu", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    useComposerDraftStore.setState({
      draftsByThreadId: {},
      draftThreadsByThreadId: {},
      projectDraftThreadIdByProjectId: {},
    });
  });

  it("shows fast mode controls for Opus", async () => {
    const mounted = await mountMenu();

    try {
      await page.getByLabelText("More composer controls").click();

      await vi.waitFor(() => {
        const text = document.body.textContent ?? "";
        expect(text).toContain("Fast Mode");
        expect(text).toContain("off");
        expect(text).toContain("on");
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("hides fast mode controls for non-Opus Claude models", async () => {
    const mounted = await mountMenu({ model: "claude-sonnet-4-6" });

    try {
      await page.getByLabelText("More composer controls").click();

      await vi.waitFor(() => {
        expect(document.body.textContent ?? "").not.toContain("Fast Mode");
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("shows only the provided effort options", async () => {
    const mounted = await mountMenu({
      model: "claude-sonnet-4-6",
    });

    try {
      await page.getByLabelText("More composer controls").click();

      await vi.waitFor(() => {
        const text = document.body.textContent ?? "";
        expect(text).toContain("Low");
        expect(text).toContain("Medium");
        expect(text).toContain("High");
        expect(text).not.toContain("Max");
        expect(text).toContain("Ultrathink");
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("shows a Claude thinking on/off section for Haiku", async () => {
    const mounted = await mountMenu({
      model: "claude-haiku-4-5",
      modelOptions: {
        claudeAgent: {
          thinking: true,
        },
      },
    });

    try {
      await page.getByLabelText("More composer controls").click();

      await vi.waitFor(() => {
        const text = document.body.textContent ?? "";
        expect(text).toContain("Thinking");
        expect(text).toContain("On (default)");
        expect(text).toContain("Off");
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("shows prompt-controlled Ultrathink messaging with disabled effort controls", async () => {
    const mounted = await mountMenu({
      model: "claude-opus-4-6",
      prompt: "Ultrathink:\nInvestigate this",
      modelOptions: {
        claudeAgent: {
          effort: "high",
        },
      },
    });

    try {
      await page.getByLabelText("More composer controls").click();

      await vi.waitFor(() => {
        const text = document.body.textContent ?? "";
        expect(text).toContain("Effort");
        expect(text).toContain("Remove Ultrathink from the prompt to change effort.");
        expect(text).not.toContain("Fallback Effort");
      });
    } finally {
      await mounted.cleanup();
    }
  });
});
