// @vitest-environment jsdom

import { EnvironmentId, RuntimeRequestId, ThreadId } from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { PendingUserInput } from "../../session-logic";

vi.mock("../../hooks/useTheme", () => ({ useTheme: () => ({ resolvedTheme: "dark" }) }));
vi.mock("../../hooks/useFileMetadata", () => ({ useFileMetadata: () => null }));
vi.mock("@effect/atom-react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@effect/atom-react")>()),
  useAtomValue: () => null,
}));
vi.mock("../../hooks/useSettings", () => ({
  getClientSettings: () => DEFAULT_CLIENT_SETTINGS,
  useClientSettings: (select?: (value: typeof DEFAULT_CLIENT_SETTINGS) => unknown) =>
    select ? select(DEFAULT_CLIENT_SETTINGS) : DEFAULT_CLIENT_SETTINGS,
}));
vi.mock("../../state/use-atom-query-runner", () => ({ useAtomQueryRunner: () => vi.fn() }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("../../state/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/session")>()),
  useEnvironmentScope: () => false,
  readEnvironmentScope: () => false,
  usePreparedConnection: () => ({ _tag: "None" }),
}));
vi.mock("~/lib/openPullRequestLink", () => ({
  findProjectOnChangeRequestHost: () => undefined,
  parseChangeRequestUrl: () => null,
  resolvePullRequestPreviewTarget: () => null,
  useOpenChangeRequestLink: () => () => false,
}));
vi.mock("../../state/entities", () => ({
  readThreadShell: () => null,
  useProjects: () => [],
  useServerConfigs: () => new Map(),
}));
vi.mock("../../remoteOpen", () => ({
  useRemoteOpenResolution: () => ({ state: { mode: "local-exec" }, isResolved: true }),
}));
vi.mock("../ui/tooltip", async () => {
  const { cloneElement, isValidElement } = await import("react");
  return {
    Tooltip: ({ children }: { children: ReactNode }) => children,
    TooltipTrigger({ render, children }: { render: ReactNode; children?: ReactNode }) {
      if (!isValidElement(render)) return children;
      return children === undefined ? render : cloneElement(render, undefined, children);
    },
    TooltipPopup: () => null,
  };
});

import { ComposerPendingUserInputPanel } from "./ComposerPendingUserInputPanel";

const question: PendingUserInput["questions"][number] = {
  id: "login",
  header: "Question",
  question:
    "Open [Linear login link](https://example.com/login?state=test) and confirm **when ready**.",
  options: [
    {
      label: "**Done**",
      description: "Use `the browser` or read [help](https://example.com/help).",
    },
  ],
  multiSelect: false,
};
const prompt: PendingUserInput = {
  requestId: RuntimeRequestId.make("markdown-question"),
  createdAt: "2026-10-11T00:00:00.000Z",
  responseCapability: "live",
  dismissible: true,
  questions: [question],
};
const onToggleOption = vi.fn();
const onAdvance = vi.fn();
let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  onToggleOption.mockReset();
  onAdvance.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function renderPanel(questions = [question], disabled = false) {
  await act(async () => {
    root.render(
      <ComposerPendingUserInputPanel
        cwd="/work"
        threadRef={{
          environmentId: EnvironmentId.make("test-environment"),
          threadId: ThreadId.make("test-thread"),
        }}
        pendingUserInputs={[{ ...prompt, questions }]}
        disabled={disabled}
        respondingRequestIds={[]}
        answers={{}}
        questionIndex={0}
        onToggleOption={onToggleOption}
        onAdvance={onAdvance}
        onDismiss={() => {}}
      />,
    );
  });
}

function element<T extends Element>(selector: string, type: { new (): T }): T {
  const target = container.querySelector(selector);
  if (!(target instanceof type)) throw new Error(`Missing ${selector}`);
  return target;
}

describe("question Markdown", () => {
  it("renders the sign-in link and emphasis instead of their Markdown source", async () => {
    await renderPanel();
    const link = element('a[href="https://example.com/login?state=test"]', HTMLAnchorElement);
    expect(link.textContent).toBe("Linear login link");
    expect(container.querySelector("strong")?.textContent).toBe("when ready");
    expect(container.textContent).not.toContain("[Linear login link]");
  });

  it("collapses to readable text without link destinations or formatting delimiters", async () => {
    await renderPanel();
    const toggle = element("[data-pending-user-input-toggle]", HTMLButtonElement);
    await act(async () => toggle.click());
    const preview = element("[data-pending-user-input-preview]", HTMLSpanElement);
    expect(preview.textContent).toContain("Linear login link");
    expect(preview.textContent).not.toContain("https://");
    expect(preview.textContent).not.toContain("**");
    expect(preview.querySelector("a")?.closest("button")).toBeNull();
    expect(preview.hasAttribute("inert")).toBe(true);
  });

  it("renders block Markdown in the expanded question", async () => {
    await renderPanel([
      {
        ...question,
        question:
          "## Checks\n\n- **Links**\n- `Values`\n\n| Check | Result |\n| --- | --- |\n| Links | Ready |",
      },
    ]);
    expect(container.querySelector("h2")?.textContent).toBe("Checks");
    expect([...container.querySelectorAll("li")].map((item) => item.textContent)).toEqual([
      "Links",
      "Values",
    ]);
    expect(container.querySelector("table")?.textContent).toContain("LinksReady");
  });

  it("resolves relative question links against the thread workspace", async () => {
    await renderPanel([{ ...question, question: "Read [the guide](docs/guide.md)." }]);
    const link = element('a[href="/work/docs/guide.md"]', HTMLAnchorElement);
    expect(link.textContent).toContain("guide.md");
  });

  it("keeps reference-link labels and escaped literal punctuation in the preview", async () => {
    await renderPanel([
      {
        ...question,
        question:
          "Open [help][login] and keep \\*literal\\*.\n\n[login]: https://example.com/long-destination",
      },
    ]);
    const toggle = element("[data-pending-user-input-toggle]", HTMLButtonElement);
    await act(async () => toggle.click());
    const preview = element("[data-pending-user-input-preview]", HTMLSpanElement);
    expect(preview.textContent).toContain("Open help and keep *literal*.");
    expect(preview.textContent).not.toContain("long-destination");
  });

  it.each([
    "First<br>Second",
    "First<br />Second",
    "First<BR>Second",
    "<p>First</p><p>Second</p>",
    "First<div>Second</div>Third",
    "<em>First</em>Second",
    "<p>First &amp; second</p>",
    "<p>First</p><script>hidden()</script><p>Second</p>",
  ])("uses the expanded renderer unchanged in the collapsed preview: %s", async (markdown) => {
    await renderPanel([{ ...question, question: markdown }]);
    const expanded = element(".chat-markdown", HTMLDivElement);
    const rendered = expanded.innerHTML;
    const toggle = element("[data-pending-user-input-toggle]", HTMLButtonElement);
    await act(async () => toggle.click());
    const preview = element("[data-pending-user-input-preview] .chat-markdown", HTMLDivElement);
    expect(preview.innerHTML).toBe(rendered);
    expect(preview.textContent).not.toContain("hidden()");
  });

  it("renders option formatting without nesting links inside selection buttons", async () => {
    await renderPanel();
    const link = element('a[href="https://example.com/help"]', HTMLAnchorElement);
    expect(link.closest("button")).toBeNull();
    expect(container.querySelector("code")?.textContent).toBe("the browser");
    expect([...container.querySelectorAll("strong")].map((node) => node.textContent)).toContain(
      "Done",
    );
  });

  it("preserves option description paragraphs with the existing renderer", async () => {
    await renderPanel([
      {
        ...question,
        options: [{ label: "**Done**", description: "<p>First</p><p>Second</p>" }],
      },
    ]);
    const button = element("button[aria-pressed]", HTMLButtonElement);
    const descriptionId = button.getAttribute("aria-describedby");
    if (!descriptionId) throw new Error("Missing option description");
    const description = document.getElementById(descriptionId);
    if (!description) throw new Error("Missing rendered option description");
    expect([...description.querySelectorAll("p")].map((node) => node.textContent)).toEqual([
      "First",
      "Second",
    ]);
  });

  it.each([false, true])(
    "does not answer on an option link click (multiSelect=%s)",
    async (multiSelect) => {
      await renderPanel([{ ...question, multiSelect }]);
      const link = element('a[href="https://example.com/help"]', HTMLAnchorElement);
      const click = new MouseEvent("click", { bubbles: true, cancelable: true });
      // Stop jsdom navigation after the real React click handler runs.
      document.addEventListener("click", (event) => event.preventDefault(), { once: true });
      await act(async () => link.dispatchEvent(click));
      await act(async () => vi.advanceTimersByTime(200));
      expect(onToggleOption).not.toHaveBeenCalled();
      expect(onAdvance).not.toHaveBeenCalled();
    },
  );

  it("submits the original option value after a formatted option is selected", async () => {
    await renderPanel();
    const button = [...container.querySelectorAll("button")].find(
      (candidate) => candidate.getAttribute("aria-pressed") !== null,
    );
    if (!button) throw new Error("Missing option selection button");
    await act(async () => button.click());
    expect(onToggleOption).toHaveBeenCalledWith("login", "**Done**");
    await act(async () => vi.advanceTimersByTime(200));
    expect(onAdvance).toHaveBeenCalledTimes(1);
  });

  it("preserves an explicit option value and number-key selection", async () => {
    await renderPanel([
      {
        ...question,
        options: [
          { ...question.options[0], label: "**Done**", description: "Ready", value: "  done  " },
        ],
      },
    ]);
    await act(async () =>
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "1", bubbles: true })),
    );
    expect(onToggleOption).toHaveBeenCalledWith("login", "  done  ");
    await act(async () => vi.advanceTimersByTime(200));
    expect(onAdvance).toHaveBeenCalledTimes(1);
  });

  it("toggles multi-select answers without advancing", async () => {
    await renderPanel([{ ...question, multiSelect: true }]);
    const button = element("button[aria-pressed]", HTMLButtonElement);
    await act(async () => button.click());
    expect(onToggleOption).toHaveBeenCalledWith("login", "**Done**");
    await act(async () => vi.advanceTimersByTime(200));
    expect(onAdvance).not.toHaveBeenCalled();
  });

  it.each(["ctrlKey", "metaKey"])(
    "preserves native modified link clicks with %s",
    async (modifier) => {
      await renderPanel();
      const link = element('a[href="https://example.com/help"]', HTMLAnchorElement);
      let nativeActionAllowed = false;
      document.addEventListener(
        "click",
        (event) => {
          nativeActionAllowed = !event.defaultPrevented;
          event.preventDefault();
        },
        { once: true },
      );
      await act(async () =>
        link.dispatchEvent(
          new MouseEvent("click", { bubbles: true, cancelable: true, [modifier]: true }),
        ),
      );
      expect(nativeActionAllowed).toBe(true);
      expect(onToggleOption).not.toHaveBeenCalled();
      expect(onAdvance).not.toHaveBeenCalled();
    },
  );

  it("does not select a formatted answer when responses are disabled", async () => {
    await renderPanel([question], true);
    const button = element("button[aria-pressed]", HTMLButtonElement);
    expect(button.disabled).toBe(true);
    await act(async () => button.click());
    expect(onToggleOption).not.toHaveBeenCalled();
  });
});
