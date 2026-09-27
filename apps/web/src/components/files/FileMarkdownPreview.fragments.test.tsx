// @vitest-environment jsdom

import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("@effect/atom-react", () => ({ useAtomValue: () => null }));
vi.mock("../../hooks/useTheme", () => ({ useTheme: () => ({ resolvedTheme: "dark" }) }));
vi.mock("../../hooks/useSettings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../hooks/useSettings")>();
  const settings = actual.getClientSettings();
  return {
    ...actual,
    useClientSettings: (select?: (value: typeof settings) => unknown) =>
      select ? select(settings) : settings,
  };
});
vi.mock("../ui/tooltip", async () => {
  const { cloneElement, isValidElement } = await import("react");
  return {
    Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    TooltipTrigger: ({
      render,
      children,
    }: {
      render: React.ReactNode;
      children?: React.ReactNode;
    }) => (isValidElement(render) ? cloneElement(render, undefined, children) : <>{children}</>),
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
  resolvePullRequestPreviewTarget: () => null,
  useOpenChangeRequestLink: () => vi.fn(),
}));

import { FileMarkdownPreview } from "./FileMarkdownPreview";

afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Markdown file preview fragments", () => {
  it("scrolls to repeated heading slugs without replacing the desktop route", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    window.history.replaceState(null, "", "/#/environment/thread");
    const route = window.location.href;
    const pushState = vi.spyOn(window.history, "pushState");
    const scrollIntoView = vi.fn();
    const originalScrollIntoView = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      "scrollIntoView",
    );
    HTMLElement.prototype.scrollIntoView = scrollIntoView;
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    try {
      await act(async () => {
        root.render(
          <FileMarkdownPreview
            cwd="/project"
            relativePath="README.md"
            threadRef={{
              environmentId: EnvironmentId.make("environment"),
              threadId: ThreadId.make("thread"),
            }}
            text={[
              "[Second](#operating-model-2) · [Missing](#missing)",
              "## Operating Model",
              "## Operating Model",
              '<span id="operating-model-1"></span>',
            ].join("\n\n")}
          />,
        );
      });

      const target = container.querySelector("#user-content-operating-model-2");
      expect(target?.textContent).toBe("Operating Model");
      await act(async () => {
        container.querySelector<HTMLAnchorElement>('a[href="#operating-model-2"]')?.click();
      });
      expect(scrollIntoView).toHaveBeenCalledOnce();
      expect(scrollIntoView.mock.contexts[0]).toBe(target);
      expect(scrollIntoView).toHaveBeenCalledWith({ block: "start" });

      const outsideTarget = document.createElement("div");
      outsideTarget.id = "missing";
      document.body.append(outsideTarget);
      await act(async () => {
        container.querySelector<HTMLAnchorElement>('a[href="#missing"]')?.click();
      });
      expect(window.location.href).toBe(route);
      expect(pushState).not.toHaveBeenCalled();
      expect(scrollIntoView).toHaveBeenCalledOnce();
    } finally {
      await act(async () => root.unmount());
      if (originalScrollIntoView) {
        Object.defineProperty(HTMLElement.prototype, "scrollIntoView", originalScrollIntoView);
      } else {
        Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
      }
    }
  });
});
