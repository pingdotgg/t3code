import { ApprovalRequestId } from "@t3tools/contracts";
import { act, type ComponentProps, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { ComposerPendingUserInputPanel } from "./ComposerPendingUserInputPanel";
import type { PendingUserInput } from "../../session-logic";
import { Collapsible } from "../ui/collapsible";

const linkActions = vi.hoisted(() => ({
  openExternal: vi.fn(async (_url: string) => {}),
  toast: vi.fn(),
}));
vi.mock("../../localApi", () => ({
  readLocalApi: () => ({ shell: { openExternal: linkActions.openExternal } }),
}));
vi.mock("../ui/toast", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../ui/toast")>()),
  toastManager: { add: linkActions.toast },
}));

vi.mock("@effect/atom-react", () => ({ useAtomValue: () => null }));
vi.mock("../../hooks/useTheme", () => ({ useTheme: () => ({ resolvedTheme: "dark" }) }));
vi.mock("../../hooks/useSettings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../hooks/useSettings")>();
  const settings = actual.getClientSettings();
  return {
    ...actual,
    ensureClientSettingsHydrated: async () => {},
    useClientSettings: (select?: (value: typeof settings) => unknown) =>
      select ? select(settings) : settings,
  };
});
vi.mock("../ui/tooltip", async () => {
  const { cloneElement, isValidElement } = await import("react");
  return {
    Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
    TooltipTrigger({
      render,
      children,
    }: ComponentProps<typeof import("../ui/tooltip").TooltipTrigger>) {
      if (!isValidElement(render)) return <>{children}</>;
      return children === undefined ? render : cloneElement(render, undefined, children);
    },
    TooltipPopup: () => null,
  };
});
vi.mock("../../state/use-atom-query-runner", () => ({ useAtomQueryRunner: () => vi.fn() }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("../../state/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/session")>()),
  usePreparedConnection: () => ({ _tag: "Loading" }),
}));
vi.mock("../../state/entities", () => ({
  readThreadShell: () => null,
  useProjects: () => [],
  useServerConfigs: () => new Map(),
}));
vi.mock("../../remoteOpen", () => ({
  useRemoteOpenResolution: () => ({ state: { mode: "local-exec" }, isResolved: true }),
}));
vi.mock("../../editorPreferences", () => ({
  useOpenInPreferredEditor: () => vi.fn(),
  usePreferredEditor: () => [null, vi.fn()],
}));
vi.mock("~/lib/openPullRequestLink", () => ({
  findProjectOnChangeRequestHost: () => undefined,
  parseChangeRequestUrl: () => null,
  useOpenChangeRequestLink: () => vi.fn(),
}));

const prompt: PendingUserInput = {
  requestId: ApprovalRequestId.make("request-1"),
  createdAt: "2026-08-15T00:00:00.000Z",
  questions: [
    {
      id: "question-1",
      header: "Approach",
      question: "Which approach should the migration take?",
      options: [
        { label: "Incremental", description: "Move one module at a time" },
        { label: "Big bang", description: "Move everything in one release" },
      ],
      multiSelect: false,
    },
  ],
  dismissible: true,
};

/** Renders a pending question without mounting client effects for Markdown output assertions. */
function renderPanel(pendingUserInput: PendingUserInput = prompt) {
  return renderToStaticMarkup(
    <ComposerPendingUserInputPanel
      pendingUserInputs={[pendingUserInput]}
      respondingRequestIds={[]}
      answers={{}}
      questionIndex={0}
      onToggleOption={() => {}}
      onAdvance={() => {}}
      onDismiss={() => {}}
    />,
  );
}

/** Mounts the card inside act so selection and auto-advance tests observe committed effects. */
async function renderInteractivePanel(
  pendingUserInput: PendingUserInput,
  onToggleOption: (questionId: string, optionValue: string) => void,
  onAdvance: () => void,
) {
  let renderer!: ReactTestRenderer;
  await act(() => {
    renderer = create(
      <ComposerPendingUserInputPanel
        pendingUserInputs={[pendingUserInput]}
        respondingRequestIds={[]}
        answers={{}}
        questionIndex={0}
        onToggleOption={onToggleOption}
        onAdvance={onAdvance}
        onDismiss={() => {}}
      />,
    );
  });
  return renderer;
}

/** Reads rendered text across Markdown wrappers for readable-preview assertions. */
function textContent(node: ReactTestInstance): string {
  return node.children
    .map((child) => (typeof child === "string" ? child : textContent(child)))
    .join("");
}

describe("ComposerPendingUserInputPanel", () => {
  let renderer: ReactTestRenderer | undefined;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("document", {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
  });

  afterEach(async () => {
    await act(() => renderer?.unmount());
    renderer = undefined;
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.restoreAllMocks();
    linkActions.openExternal.mockClear();
    linkActions.toast.mockClear();
  });

  it("renders the header as a disclosure control for the question body", () => {
    const markup = renderPanel();

    const toggle = markup.match(/<button[^>]*data-pending-user-input-toggle="[^"]*"[^>]*>/)?.[0];
    expect(toggle).toBeDefined();
    expect(toggle).toContain('data-pending-user-input-toggle="expanded"');
    expect(toggle).toContain('aria-expanded="true"');
    expect(toggle).toContain('type="button"');

    const controlledId = toggle?.match(/aria-controls="([^"]+)"/)?.[1];
    expect(controlledId).toBeDefined();
    expect(markup).toMatch(new RegExp(`<div[^>]*\\sid="${controlledId}"`));
  });

  it("offers dismiss only for async questions", () => {
    expect(renderPanel()).toContain("data-pending-user-input-dismiss");
    expect(renderPanel({ ...prompt, dismissible: false })).not.toContain(
      "data-pending-user-input-dismiss",
    );
  });

  it("starts expanded so the question and its options are visible", () => {
    const markup = renderPanel();

    expect(markup).toContain("Approach");
    expect(markup).toContain("Which approach should the migration take?");
    expect(markup).toContain("Incremental");
    expect(markup).toContain("Big bang");
  });

  it("renders expanded questions as Markdown instead of exposing source syntax", () => {
    const markup = renderPanel({
      ...prompt,
      questions: [
        {
          ...prompt.questions[0]!,
          question:
            "Open [AWS sign-in link](https://example.com/signin?state=example) and confirm **when ready**.\n\n### Checks\n\n- Run `tests`\n\n> Review first.\n\n| Check | Result |\n| --- | --- |\n| Build | Ready |\n\n```text\nready\n```",
        },
      ],
    });
    expect(markup).toContain('href="https://example.com/signin?state=example"');
    expect(markup).toContain("<strong>when ready</strong>");
    expect(markup).toContain("<h3");
    expect(markup).toContain("<ul");
    expect(markup).toContain("<blockquote");
    expect(markup).toContain("<table");
    expect(markup).toContain("<pre");
    expect(markup).not.toContain("[AWS sign-in link](");
    expect(markup).not.toContain("**when ready**");
  });

  it("uses readable plain text for the collapsed preview", async () => {
    const pendingUserInput = {
      ...prompt,
      questions: [
        {
          ...prompt.questions[0]!,
          question:
            "Please open [AWS sign-in link](https://example.com/signin?state=example) and confirm **when ready**.",
        },
      ],
    } satisfies PendingUserInput;

    renderer = await renderInteractivePanel(
      pendingUserInput,
      () => {},
      () => {},
    );
    const collapsible = renderer.root.findByType(Collapsible);
    await act(() => collapsible.props.onOpenChange(false));

    const preview = renderer.root.findByProps({ "data-pending-user-input-preview": true });
    const previewText = textContent(preview);
    expect(previewText).toContain("Please open AWS sign-in link and confirm when ready.");
    expect(previewText).not.toContain("https://example.com/signin");
    expect(previewText).not.toContain("**");
  });

  it("renders inline formatting and removes unsafe option links", () => {
    const pendingUserInput = {
      ...prompt,
      questions: [
        {
          ...prompt.questions[0]!,
          options: [
            {
              label: "**Bold option** *emphasis* ~~old~~",
              description: "Use `inline code` and [help](https://example.com/help).",
              value: "provider-choice",
            },
            {
              label: "Safe fallback",
              description: "[bad link](javascript:alert(1))",
              value: "fallback-choice",
            },
          ],
        },
      ],
    } satisfies PendingUserInput;

    const markup = renderPanel(pendingUserInput);

    expect(markup).toContain("<strong>Bold option</strong>");
    expect(markup).toContain("<code>inline code</code>");
    expect(markup).toContain("<em>emphasis</em>");
    expect(markup).toContain("<del>old</del>");
    expect(markup).toContain('href="https://example.com/help"');
    expect(markup).not.toContain('href="javascript:');
    expect(markup).toContain("bad link");
  });

  it("submits the original option value and advances only after the selection delay", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("window", {
      setTimeout,
      clearTimeout,
    });
    const onToggleOption = vi.fn();
    const onAdvance = vi.fn();

    renderer = await renderInteractivePanel(
      {
        ...prompt,
        questions: [
          {
            ...prompt.questions[0]!,
            options: [
              {
                label: "Choose **this**",
                description: "Read [the help](https://example.com/help).",
                value: "raw-provider-value",
              },
            ],
          },
        ],
      },
      onToggleOption,
      onAdvance,
    );

    const optionButton = renderer.root
      .findAllByType("button")
      .find((button) => button.props["aria-pressed"] !== undefined);
    expect(optionButton).toBeDefined();
    await act(() => optionButton?.props.onClick());
    expect(onToggleOption).toHaveBeenCalledWith("question-1", "raw-provider-value");
    expect(onAdvance).not.toHaveBeenCalled();

    await act(() => vi.advanceTimersByTime(200));
    expect(onAdvance).toHaveBeenCalledOnce();
  });

  it("flattens block Markdown and resolves reference links in previews", async () => {
    renderer = await renderInteractivePanel(
      {
        ...prompt,
        questions: [
          {
            ...prompt.questions[0]!,
            question: [
              "# Heading",
              "Read [the **guide**][guide] &amp; `a_b`.  \nNext line.",
              "> A quote",
              "- First\n- Second",
              "| Name | Status |\n| --- | --- |\n| Build | Ready |",
              "![Diagram](https://example.com/image.png)",
              "[guide]: https://example.com/path_(nested)",
            ].join("\n\n"),
          },
        ],
      },
      () => {},
      () => {},
    );
    await act(() => renderer!.root.findByType(Collapsible).props.onOpenChange(false));
    const preview = renderer.root.findByProps({ "data-pending-user-input-preview": true });
    expect(textContent(preview).replace(/\s+/g, " ").trim()).toBe(
      "Heading Read the guide & a_b. Next line. A quote First Second Name Status Build Ready Diagram",
    );
    expect(
      preview.findAll((node) =>
        ["a", "strong", "em", "code", "br", "img", "table"].includes(String(node.type)),
      ),
    ).toHaveLength(0);
  });

  it.each([false, true])(
    "opens option links without answering (opening fails=%s)",
    async (fails) => {
      vi.useFakeTimers();
      vi.stubGlobal("window", { setTimeout, clearTimeout });
      const onToggleOption = vi.fn();
      const onAdvance = vi.fn();
      const error = new Error("Browser unavailable");
      const reportError = vi.spyOn(console, "error").mockImplementation(() => {});
      if (fails) linkActions.openExternal.mockRejectedValueOnce(error);
      const url = "https://example.com/help";
      // ReactTestRenderer has no DOM. Only the event target's anchor lookup is needed here.
      class LinkTarget {
        closest() {
          return { href: url };
        }
      }
      vi.stubGlobal("Element", LinkTarget);
      renderer = await renderInteractivePanel(
        {
          ...prompt,
          questions: [
            { ...prompt.questions[0]!, options: [{ label: `[Help](${url})`, description: "" }] },
          ],
        },
        onToggleOption,
        onAdvance,
      );
      const options = renderer.root.findAllByType("div").find((node) => node.props.onClick)!;
      const event = {
        target: new LinkTarget(),
        defaultPrevented: false,
        metaKey: false,
        ctrlKey: false,
        shiftKey: false,
        altKey: false,
        preventDefault: vi.fn(),
      };
      await act(async () => options.props.onClick(event));
      expect(linkActions.openExternal).toHaveBeenCalledExactlyOnceWith(url);
      await act(() => vi.advanceTimersByTime(200));
      expect(onToggleOption).not.toHaveBeenCalled();
      expect(onAdvance).not.toHaveBeenCalled();
      if (fails) {
        expect(reportError).toHaveBeenCalledWith(error);
        expect(linkActions.toast).toHaveBeenCalledWith({
          type: "error",
          title: "Unable to open question link",
        });
      } else {
        expect(linkActions.toast).not.toHaveBeenCalled();
      }
      // Modified clicks retain the anchor's native browser behavior.
      event.preventDefault.mockClear();
      await act(async () => options.props.onClick({ ...event, metaKey: true }));
      expect(event.preventDefault).not.toHaveBeenCalled();
      expect(linkActions.openExternal).toHaveBeenCalledTimes(1);
    },
  );

  it.each([false, true])(
    "keeps raw fallback labels and cleans up auto-advance (multiSelect=%s)",
    async (multiSelect) => {
      vi.useFakeTimers();
      vi.stubGlobal("window", { setTimeout, clearTimeout });
      const onToggleOption = vi.fn();
      const onAdvance = vi.fn();
      renderer = await renderInteractivePanel(
        {
          ...prompt,
          questions: [
            {
              ...prompt.questions[0]!,
              multiSelect,
              options: [{ label: "**Raw label**", description: "" }],
            },
          ],
        },
        onToggleOption,
        onAdvance,
      );
      const button = renderer.root
        .findAllByType("button")
        .find((node) => node.props["aria-pressed"] !== undefined)!;
      await act(() => button.props.onClick());
      expect(onToggleOption).toHaveBeenCalledWith("question-1", "**Raw label**");
      if (multiSelect) {
        await act(() => vi.advanceTimersByTime(200));
        expect(onAdvance).not.toHaveBeenCalled();
      }
      await act(() => renderer!.unmount());
      renderer = undefined;
      await act(() => vi.advanceTimersByTime(200));
      expect(onAdvance).not.toHaveBeenCalled();
    },
  );
});
