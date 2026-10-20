import type { WorkflowOpening } from "@t3tools/client-runtime/state/subagentRuntime";
import { EnvironmentId } from "@t3tools/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import "~/index.css";
import { getSyntaxHighlighterPromise } from "../../lib/syntaxHighlighting";
import { AppAtomRegistryProvider } from "../../rpc/atomRegistry";
import { MarkdownFindContext } from "./markdownFindContext";
import { useThreadFindHighlights } from "./threadFindHighlights";
import { WorkflowOpeningBlock } from "./WorkflowOpeningBlock";

vi.mock(import("../../state/server"), async (original) => {
  const actual = await original();
  const { Atom } = await import("effect/reactivity");
  const providers = Atom.make([]).pipe(Atom.keepAlive);
  const noConfig = Atom.make(null);
  return {
    ...actual,
    providersIgnoringCheckedAtAtom: (() => providers) as never,
    serverEnvironment: { ...actual.serverEnvironment, configValueAtom: (() => noConfig) as never },
  };
});
// Loading the real Shiki WASM and grammar can take seconds on a busy runner; the block only
// needs to hand its script to the markdown code block that highlights it.
vi.mock(import("../../lib/syntaxHighlighting"), async (original) => ({
  ...(await original()),
  getSyntaxHighlighterPromise: async () =>
    ({
      codeToHtml: (code: string) =>
        Object.assign(document.createElement("pre"), { textContent: code }).outerHTML,
    }) as never,
}));

const SHORT_SCRIPT =
  "export const meta = { name: 'repo-check' }\nagent('Run SCRIPTONLY with Bash')";
const LONG_SCRIPT = [
  "export const meta = { name: 'repo-check' }",
  ...Array.from({ length: 24 }, (_, index) => `const step${index} = await agent('Step ${index}')`),
  "return 'TAILONLY'",
].join("\n");

const opening = (script: string): WorkflowOpening => ({
  messageId: "message-script",
  script,
  name: "repo-check",
  description: "Two agents each inspect one file",
  driver: null,
  providerInstanceId: null,
  group: null,
});

function Find(props: { readonly container: HTMLElement | null; readonly query: string }) {
  useThreadFindHighlights({
    container: props.container,
    query: props.query,
    activeRowId: "opening",
    activeOccurrence: 0,
    onActiveRange: () => undefined,
  });
  return null;
}

let root: Root;
let host: HTMLElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  host.style.width = "720px";
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  CSS.highlights.clear();
  vi.unstubAllGlobals();
});

async function render(script: string, query = "") {
  await act(async () =>
    root.render(
      <AppAtomRegistryProvider>
        <MarkdownFindContext value={query.length > 0}>
          <div data-timeline-row-id="opening">
            <WorkflowOpeningBlock
              opening={opening(script)}
              environmentId={EnvironmentId.make("environment-local")}
              onOpenThread={() => undefined}
            />
          </div>
        </MarkdownFindContext>
        <Find container={host} query={query} />
      </AppAtomRegistryProvider>,
    ),
  );
  await act(async () => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  });
}

const foldToggle = () =>
  [...host.querySelectorAll("button")].find((button) =>
    /Show full script|Show less/.test(button.textContent ?? ""),
  );

it("shows a short script as highlighted code with nothing to open", async () => {
  await render(SHORT_SCRIPT);
  await act(async () => {
    await getSyntaxHighlighterPromise("javascript");
  });
  expect(host.querySelector('[data-language="javascript"]')?.textContent).toContain("SCRIPTONLY");
  await act(async () => {
    await getSyntaxHighlighterPromise("javascript");
  });
  expect(host.querySelector(".chat-markdown-shiki")).not.toBeNull();
  expect(foldToggle()).toBeUndefined();
});

it("folds a long script until it is opened", async () => {
  await render(LONG_SCRIPT);
  expect(foldToggle()?.getAttribute("aria-expanded")).toBe("false");
  expect(host.querySelector("[data-thread-find-fold]")).not.toBeNull();
  await act(async () => foldToggle()?.click());
  expect(foldToggle()?.getAttribute("aria-expanded")).toBe("true");
  expect(host.querySelector("[data-thread-find-fold]")).toBeNull();
});

it("finds the workflow's name and opens a folded script on a match below the fold", async () => {
  await render(LONG_SCRIPT, "repo-check");
  expect(CSS.highlights.get("t3-thread-find-active")?.size).toBe(1);
  expect(foldToggle()?.getAttribute("aria-expanded")).toBe("false");

  await render(LONG_SCRIPT, "TAILONLY");
  expect(CSS.highlights.get("t3-thread-find-active")?.size).toBe(1);
  expect(foldToggle()?.getAttribute("aria-expanded")).toBe("true");
});
