import type { SurfaceRenderer } from "@t3tools/extension-sdk/react";
import { useEffect, useState } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vite-plus/test";
import { readContextSnapshots } from "@t3tools/extension-sdk/context";
import { createIssueContextExample } from "../../../../packages/extension-sdk/examples/issue-context/issue-context.mjs";
import { ComposerExtensionContext } from "./ComposerExtensionContext";
import { MessageDecorations } from "./MessageDecorations";
import {
  registerWorkspaceExtension,
  decorateWorkspaceMessage,
  useWorkspaceTextRevision,
} from "./workspaceRegistry";
import { recallableComposerPrompt } from "../components/chat/composerPromptHistory";
import { parseStandaloneComposerSlashCommand } from "../composer-logic";

vi.mock("~/components/ui/menu", () => ({
  Menu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  MenuTrigger: ({ children }: { children: React.ReactNode }) => <button>{children}</button>,
  MenuPopup: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  MenuItem: ({ children, onClick }: { children: React.ReactNode; onClick: () => void }) => (
    <button onClick={onClick}>{children}</button>
  ),
}));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const context = {
  resource: {
    namespace: "test.composer",
    id: "thread",
    environmentId: "env",
    projectId: "project",
    threadId: "thread",
  },
  client: "web",
};
describe("registered text contributions", () => {
  it("adds previews, removes context, captures exact text, and retains it after unregister and recall", async () => {
    let current = "/plan",
      captured = "",
      root!: ReactTestRenderer;
    const unregister = registerWorkspaceExtension(createIssueContextExample<SurfaceRenderer>());
    function Composer() {
      const [prompt, setPrompt] = useState(current);
      return (
        <>
          <ComposerExtensionContext
            prompt={prompt}
            context={context}
            onChange={(value) => {
              current = value;
              setPrompt(value);
            }}
          />
          <button
            aria-label="Submit test prompt"
            onClick={() => {
              captured = prompt;
            }}
          >
            Send
          </button>
        </>
      );
    }
    try {
      await act(async () => {
        root = create(<Composer />);
      });
      const select = () =>
        root.root
          .findAllByType("button")
          .find((button) => button.children.includes("Issue snapshot (fixture)"))!;
      await act(async () => {
        select().props.onClick();
      });
      expect(readContextSnapshots(current)).toHaveLength(1);
      expect(root.root.findByType("summary").children).toEqual(["Issue snapshot (fixture)"]);
      expect(parseStandaloneComposerSlashCommand(current)).toBeNull();
      await act(async () => {
        root.root
          .findByProps({ "aria-label": "Remove context Issue snapshot (fixture)" })
          .props.onClick();
      });
      expect(readContextSnapshots(current)).toHaveLength(0);
      await act(async () => {
        select().props.onClick();
      });
      await act(async () => {
        root.root.findByProps({ "aria-label": "Submit test prompt" }).props.onClick();
      });
      const frozen = captured;
      await act(async () => {
        unregister();
      });
      expect(current).toBe(frozen);
      expect(recallableComposerPrompt(frozen)).toBe(frozen);
      expect(root.root.findByType("summary").children).toEqual(["Issue snapshot (fixture)"]);
    } finally {
      await act(async () => {
        root?.unmount();
        unregister();
      });
    }
  });
  it("decorates only a visible message, retains original text and removes the card on unregister", async () => {
    const callbacks: IntersectionObserverCallback[] = [];
    class Observer {
      constructor(callback: IntersectionObserverCallback) {
        callbacks.push(callback);
      }
      observe() {}
      disconnect() {}
    }
    vi.stubGlobal("IntersectionObserver", Observer);
    const extension = createIssueContextExample<SurfaceRenderer>();
    const original = extension.messageDecorations![0]!.decorate;
    const decorate = vi.fn(original);
    let unregister = registerWorkspaceExtension({
      ...extension,
      messageDecorations: [{ id: "example.issue-context/card", decorate }],
    });
    let root!: ReactTestRenderer;
    // Capture through the actual registered composer before admitting the immutable string.
    let prompt = "";
    await act(async () => {
      root = create(
        <ComposerExtensionContext
          prompt=""
          context={context}
          onChange={(value) => {
            prompt = value;
          }}
        />,
      );
    });
    await act(async () => {
      root.root
        .findAllByType("button")
        .find((button) => button.children.includes("Issue snapshot (fixture)"))!
        .props.onClick();
      root.unmount();
    });
    const message = {
      environmentId: "env",
      threadId: "thread",
      messageId: "message",
      text: prompt,
    };
    try {
      await act(async () => {
        root = create(
          <>
            <p>{message.text}</p>
            <MessageDecorations message={message} />
          </>,
          { createNodeMock: () => ({}) },
        );
      });
      expect(decorate).not.toHaveBeenCalled();
      await act(async () => {
        callbacks[0]!(
          [{ isIntersecting: true } as IntersectionObserverEntry],
          {} as IntersectionObserver,
        );
      });
      expect(decorate).toHaveBeenCalledTimes(1);
      expect(root.root.findAllByType("aside")).toHaveLength(1);
      expect(root.root.findAllByType("p")[0]!.children).toEqual([prompt]);
      await act(async () => {
        unregister();
      });
      expect(root.root.findAllByType("aside")).toHaveLength(0);
      expect(root.root.findAllByType("p")[0]!.children).toEqual([prompt]);
      await act(async () => {
        unregister = registerWorkspaceExtension({
          ...extension,
          messageDecorations: [{ id: "example.issue-context/card", decorate }],
        });
      });
      expect(decorate).toHaveBeenCalledTimes(1);
      await act(async () => {
        callbacks[0]!(
          [{ isIntersecting: true } as IntersectionObserverEntry],
          {} as IntersectionObserver,
        );
        callbacks[1]!(
          [{ isIntersecting: false } as IntersectionObserverEntry],
          {} as IntersectionObserver,
        );
      });
      expect(decorate).toHaveBeenCalledTimes(1);
      await act(async () => {
        callbacks[1]!(
          [{ isIntersecting: true } as IntersectionObserverEntry],
          {} as IntersectionObserver,
        );
      });
      expect(decorate).toHaveBeenCalledTimes(2);
      await act(async () => {
        callbacks[0]!(
          [{ isIntersecting: false } as IntersectionObserverEntry],
          {} as IntersectionObserver,
        );
      });
      expect(root.root.findAllByType("aside")).toHaveLength(1);
      expect(decorate).toHaveBeenCalledTimes(2);
    } finally {
      await act(async () => {
        root?.unmount();
        unregister();
      });
      vi.unstubAllGlobals();
    }
  });
});

it.each([
  { cards: false, calls: 16 },
  { cards: true, calls: 4 },
])(
  "bounds projector invocation across registered extensions ($calls calls)",
  async ({ cards, calls }) => {
    const callbacks: IntersectionObserverCallback[] = [];
    class Observer {
      constructor(callback: IntersectionObserverCallback) {
        callbacks.push(callback);
      }
      observe() {}
      disconnect() {}
    }
    vi.stubGlobal("IntersectionObserver", Observer);
    const projectors = Array.from({ length: 20 }, () =>
      vi.fn(() => (cards ? { title: "Fixture", text: "Bounded card" } : null)),
    );
    const cleanup = projectors.map((decorate, index) => {
      const id = "budget.extension-" + index;
      return registerWorkspaceExtension({
        manifest: {
          id,
          version: "1.0.0",
          apiVersion: 1,
          surfaces: [],
          messageDecorations: [{ id: id + "/card", title: "Budget fixture", clients: ["web"] }],
        },
        surfaces: [],
        messageDecorations: [{ id: id + "/card", decorate }],
      });
    });
    let root!: ReactTestRenderer;
    try {
      await act(async () => {
        root = create(
          <MessageDecorations
            message={{
              environmentId: "env",
              threadId: "thread",
              messageId: "message",
              text: "body",
            }}
          />,
          { createNodeMock: () => ({}) },
        );
      });
      expect(projectors.every((projector) => projector.mock.calls.length === 0)).toBe(true);
      await act(async () => {
        callbacks[0]!(
          [{ isIntersecting: true } as IntersectionObserverEntry],
          {} as IntersectionObserver,
        );
      });
      expect(projectors.reduce((count, projector) => count + projector.mock.calls.length, 0)).toBe(
        calls,
      );
      expect(projectors.slice(calls).every((projector) => projector.mock.calls.length === 0)).toBe(
        true,
      );
    } finally {
      await act(async () => {
        root?.unmount();
        cleanup.forEach((unregister) => unregister());
      });
      vi.unstubAllGlobals();
    }
  },
);

it("does not read message payloads for unrelated context or other-client hosts", async () => {
  let revision = -1;
  let reads = 0;
  let root!: ReactTestRenderer;
  const cleanup: Array<() => void> = [];
  const decorate = vi.fn(() => ({ title: "Card", text: "Captured" }));
  const desktopDecorate = vi.fn(() => null);
  function Revision() {
    const current = useWorkspaceTextRevision();
    useEffect(() => {
      revision = current;
    }, [current]);
    return null;
  }
  const message = {
    environmentId: "env",
    threadId: "thread",
    messageId: "message",
    get text() {
      reads += 1;
      return "body";
    },
  };
  try {
    cleanup.push(
      registerWorkspaceExtension({
        manifest: {
          id: "copy.active",
          version: "1.0.0",
          apiVersion: 1,
          surfaces: [],
          messageDecorations: [{ id: "copy.active/card", title: "Card", clients: ["web"] }],
        },
        surfaces: [],
        messageDecorations: [{ id: "copy.active/card", decorate }],
      }),
    );
    await act(async () => {
      root = create(<Revision />);
    });
    expect(decorateWorkspaceMessage(message, "web", revision)).toHaveLength(1);
    const baselineReads = reads;
    expect(baselineReads).toBeGreaterThan(0);
    await act(async () => {
      cleanup.push(
        registerWorkspaceExtension({
          manifest: {
            id: "copy.context",
            version: "1.0.0",
            apiVersion: 1,
            surfaces: [],
            composerContexts: [{ id: "copy.context/select", title: "Context", clients: ["web"] }],
          },
          surfaces: [],
          composerContexts: [
            { id: "copy.context/select", select: () => ({ title: "Context", text: "Body" }) },
          ],
        }),
      );
      cleanup.push(
        registerWorkspaceExtension({
          manifest: {
            id: "copy.desktop",
            version: "1.0.0",
            apiVersion: 1,
            surfaces: [],
            messageDecorations: [
              { id: "copy.desktop/card", title: "Desktop", clients: ["desktop"] },
            ],
          },
          surfaces: [],
          messageDecorations: [{ id: "copy.desktop/card", decorate: desktopDecorate }],
        }),
      );
    });
    reads = 0;
    expect(decorateWorkspaceMessage(message, "web", revision)).toHaveLength(1);
    expect(reads).toBe(baselineReads);
    expect(decorate).toHaveBeenCalledTimes(2);
    expect(desktopDecorate).not.toHaveBeenCalled();
  } finally {
    await act(async () => {
      root?.unmount();
      cleanup.forEach((unregister) => unregister());
    });
  }
});
