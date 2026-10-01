// Pack fixtures read source files synchronously, outside Effect services.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import * as NodeFS from "node:fs";
// @vitest-environment jsdom

import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import { hostUiKit as testKit } from "./hostUiKit";
import type { BrowserSession } from "@t3tools/extension-sdk/catalogue";
import type { ClientHost, FloatingPopoverProps } from "@t3tools/extension-sdk/environment";
import type { ClientUiKit, UiTreeRowProps } from "@t3tools/extension-sdk/ui";
import { TooltipProvider } from "~/components/ui/tooltip";
import { PreviewChromeRow } from "~/components/preview/PreviewChromeRow";
import { hostTooltip } from "./hostTooltip";
import { BROWSER_SURFACE_OVERLAY_ATTRIBUTE } from "@t3tools/extension-sdk/catalogue";
import { createExtensionHost, type ViewSession } from "@t3tools/extension-sdk/host";
import { ExtensionSurface, type SurfaceRenderer } from "@t3tools/extension-sdk/react";

type PageMenuProps = {
  host: Pick<ClientHost, "React" | "tooltip" | "uiKit">;
  session: BrowserSession | null;
  blockReason: string | null;
  run: (verb: { method: string }) => void;
  zoomStep: (direction: "in" | "out") => void;
  visible: boolean;
  floating: { Popover: React.ComponentType<FloatingPopoverProps>; style: React.CSSProperties };
  children?: (close: () => void) => React.ReactNode;
};

type ProfileSectionProps = {
  host: Pick<ClientHost, "uiKit">;
  session: BrowserSession;
  api: { invoke: (method: string, input: unknown, signal: AbortSignal) => Promise<unknown> };
  profiles: {
    subscribe: (listener: () => void) => () => void;
    getSnapshot: () => { list: null; error: null };
    refresh: () => void;
  };
  signal: AbortSignal;
  onOpenInProfile: (profileId: string) => void;
  report: (message: string) => void;
  onChosen: () => void;
};

async function loadPageMenu() {
  const menuPath = "../../../../packages/first-party-extensions/browser/pageMenu.tsx";
  const module: { PageMenu: React.ComponentType<PageMenuProps> } = await import(
    new URL(menuPath, import.meta.url).pathname
  );
  return module.PageMenu;
}

function pageMenuProps(overrides: Partial<PageMenuProps> = {}): PageMenuProps {
  return {
    host: { React, tooltip: hostTooltip, uiKit: testKit },
    session: {
      zoomFactor: 1,
      appearance: "system",
      audioMuted: null,
      devToolsOpen: false,
      pictureInPicture: null,
    } as BrowserSession,
    blockReason: null,
    run: vi.fn(),
    zoomStep: vi.fn(),
    visible: true,
    floating: { Popover: () => null, style: {} },
    ...overrides,
  };
}

async function openPageMenu() {
  const trigger = container.querySelector<HTMLButtonElement>('[aria-label="Preview menu"]')!;
  await act(async () => {
    trigger.focus();
    trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
  });
  return trigger;
}

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it.skipIf(
  !NodeFS.existsSync(
    new URL("../../../../packages/first-party-extensions/files/treeRow.tsx", import.meta.url),
  ),
)("uses native file-type icons, selection and focus without changing the path", async () => {
  const rowPath = "../../../../packages/first-party-extensions/files/treeRow.tsx";
  const {
    FileTreeRow,
  }: { FileTreeRow: React.ComponentType<UiTreeRowProps & { kit: ClientUiKit | null }> } =
    await import(new URL(rowPath, import.meta.url).pathname);
  const selected = vi.fn();
  await act(async () =>
    root.render(
      <FileTreeRow
        kit={testKit}
        path="src/view.tsx"
        depth={1}
        directory={false}
        selected
        onClick={selected}
      />,
    ),
  );
  const row = container.querySelector("button")!;
  expect(row.textContent).toBe("view.tsx");
  expect(row.getAttribute("aria-selected")).toBe("true");
  expect(row.getAttribute("aria-level")).toBe("2");
  expect(container.querySelector("use")?.getAttribute("href")).toBe("#file-tree-builtin-react");
  row.focus();
  expect(document.activeElement).toBe(row);
  await act(async () => row.click());
  expect(selected).toHaveBeenCalledOnce();
});

it("the Browser more menu invokes once and returns focus on Escape", async () => {
  const PageMenu = await loadPageMenu();
  const run = vi.fn();
  await act(async () =>
    root.render(
      <TooltipProvider delay={0}>
        <PageMenu {...pageMenuProps({ run })} />
      </TooltipProvider>,
    ),
  );
  const trigger = await openPageMenu();
  const menu = document.querySelector('[role="menu"]')!;
  expect(menu).not.toBeNull();
  const reload = Array.from(menu.querySelectorAll<HTMLElement>('[role="menuitem"]')).find(
    (item) => item.textContent === "Hard reload",
  )!;
  await act(async () => reload.click());
  expect(run).toHaveBeenCalledExactlyOnceWith({ method: "hardReload" });
  await act(async () =>
    trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })),
  );
  await act(async () =>
    document.activeElement?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    ),
  );
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
  expect(document.activeElement).toBe(trigger);
});

it("opens the native appearance submenu from the keyboard and selects a reported radio value", async () => {
  const PageMenu = await loadPageMenu();
  const run = vi.fn();
  await act(async () =>
    root.render(
      <TooltipProvider delay={0}>
        <PageMenu {...pageMenuProps({ run })} />
      </TooltipProvider>,
    ),
  );
  await openPageMenu();
  const appearance = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]')).find(
    (item) => item.textContent === "Appearance",
  )!;
  await act(async () => {
    appearance.focus();
    appearance.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
  });
  const radios = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitemradio"]'));
  expect(radios.find((item) => item.textContent === "System")?.getAttribute("aria-checked")).toBe(
    "true",
  );
  await act(async () => radios.find((item) => item.textContent === "Dark")!.click());
  expect(run).toHaveBeenCalledExactlyOnceWith({ method: "setAppearance", appearance: "dark" });
});

it("keeps zoom controls open and closes a retained menu when hidden", async () => {
  const PageMenu = await loadPageMenu();
  const zoomStep = vi.fn();
  const props = pageMenuProps({ zoomStep });
  await act(async () =>
    root.render(
      <TooltipProvider delay={0}>
        <PageMenu {...props} />
      </TooltipProvider>,
    ),
  );
  const trigger = await openPageMenu();
  await act(async () =>
    document.querySelector<HTMLButtonElement>('[aria-label="Zoom in"]')!.click(),
  );
  expect(zoomStep).toHaveBeenCalledExactlyOnceWith("in");
  expect(trigger.getAttribute("aria-expanded")).toBe("true");
  await act(async () =>
    root.render(
      <TooltipProvider delay={0}>
        <PageMenu {...props} visible={false} />
      </TooltipProvider>,
    ),
  );
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
  await act(async () =>
    root.render(
      <TooltipProvider delay={0}>
        <PageMenu {...props} />
      </TooltipProvider>,
    ),
  );
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
});

it("navigates past disabled page actions to an enabled profile action", async () => {
  const PageMenu = await loadPageMenu();
  const selected = vi.fn();
  const props = pageMenuProps({
    blockReason: "Needs permission",
    children: () => <testKit.MenuItem onClick={selected}>Clear cache</testKit.MenuItem>,
  });
  await act(async () =>
    root.render(
      <TooltipProvider delay={0}>
        <PageMenu {...props} />
      </TooltipProvider>,
    ),
  );
  await openPageMenu();
  expect(document.activeElement?.textContent).toBe("Clear cache");
  await act(async () =>
    document.activeElement?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    ),
  );
  expect(selected).toHaveBeenCalledOnce();
  expect(props.run).not.toHaveBeenCalled();
});

it("preserves native address focus, submission and cancellation", async () => {
  const addressPath = "../../../../packages/first-party-extensions/browser/addressInput.tsx";
  const {
    AddressInput,
  }: {
    AddressInput: React.ComponentType<{
      host: Pick<ClientHost, "uiKit">;
      value: string;
      committed: string;
      onValueChange: (value: string) => void;
      onSubmit: (value: string) => void;
      inputRef: React.Ref<HTMLInputElement>;
      style: React.CSSProperties;
    }>;
  } = await import(new URL(addressPath, import.meta.url).pathname);
  const onSubmit = vi.fn();
  const onValueChange = vi.fn();
  const inputRef = React.createRef<HTMLInputElement>();
  await act(async () =>
    root.render(
      <AddressInput
        host={{ uiKit: testKit }}
        value="  https://draft.example/  "
        committed="https://committed.example/"
        onValueChange={onValueChange}
        onSubmit={onSubmit}
        inputRef={inputRef}
        style={{}}
      />,
    ),
  );
  const input = inputRef.current!;
  await act(async () => input.focus());
  expect(input.getAttribute("spellcheck")).toBe("false");
  expect(input.selectionStart).toBe(0);
  expect(input.selectionEnd).toBe(input.value.length);
  await act(async () =>
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })),
  );
  expect(onSubmit).toHaveBeenCalledExactlyOnceWith("https://draft.example/");
  expect(document.activeElement).not.toBe(input);
  await act(async () => input.focus());
  onValueChange.mockClear();
  await act(async () =>
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
  );
  expect(onValueChange).toHaveBeenCalledExactlyOnceWith("https://committed.example/");
  expect(document.activeElement).not.toBe(input);
});

it.skipIf(
  !NodeFS.existsSync(
    new URL("../../../../packages/first-party-extensions/files/treeRow.tsx", import.meta.url),
  ),
)("keeps plain tree controls functional on a host without UI primitives", async () => {
  const rowPath = "../../../../packages/first-party-extensions/files/treeRow.tsx";
  const {
    FileTreeRow,
  }: { FileTreeRow: React.ComponentType<UiTreeRowProps & { kit: ClientUiKit | null }> } =
    await import(new URL(rowPath, import.meta.url).pathname);
  const selected = vi.fn();
  await act(async () =>
    root.render(
      <FileTreeRow kit={null} path="src" depth={0} directory expanded onClick={selected} />,
    ),
  );
  const row = container.querySelector("button")!;
  expect(row.getAttribute("aria-expanded")).toBe("true");
  expect(row.textContent).toContain("src/");
  await act(async () => row.click());
  expect(selected).toHaveBeenCalledOnce();
});

it("opens the real held-session profile menu and clears its current profile", async () => {
  const PageMenu = await loadPageMenu();
  const profilePath = "../../../../packages/first-party-extensions/browser/profileMenu.tsx";
  const {
    ProfileSection,
  }: {
    ProfileSection: React.ComponentType<ProfileSectionProps>;
  } = await import(new URL(profilePath, import.meta.url).pathname);
  const invoke = vi.fn().mockResolvedValue({ cleared: true });
  const snapshot = { list: null, error: null };
  const profiles = { subscribe: () => () => {}, getSnapshot: () => snapshot, refresh: vi.fn() };
  const props = pageMenuProps();
  await act(async () =>
    root.render(
      <TooltipProvider delay={0}>
        <PageMenu {...props}>
          {(close) => (
            <ProfileSection
              host={props.host}
              session={props.session!}
              api={{ invoke }}
              profiles={profiles}
              signal={new AbortController().signal}
              onOpenInProfile={vi.fn()}
              report={vi.fn()}
              onChosen={close}
            />
          )}
        </PageMenu>
      </TooltipProvider>,
    ),
  );
  await openPageMenu();
  const menu = document.querySelector('[role="menu"]')!;
  expect(menu.textContent).toContain("Profile: Default");
  expect(menu.querySelector<HTMLElement>('[title="Profile: Default"]')?.style.maxWidth).toBe(
    "256px",
  );
  expect(
    Array.from(menu.querySelectorAll('[role="note"]'))
      .find((note) => note.textContent === "Loading profiles…")!
      .classList.contains("px-2"),
  ).toBe(true);
  const mute = Array.from(menu.querySelectorAll<HTMLElement>('[role="menuitem"]')).find(
    (item) => item.textContent === "Mute page",
  )!;
  expect(mute.previousElementSibling?.getAttribute("role")).toBe("separator");
  const clear = Array.from(menu.querySelectorAll<HTMLElement>('[role="menuitem"]')).find(
    (item) => item.textContent === "Clear cookies",
  )!;
  await act(async () => clear.click());
  expect(invoke).toHaveBeenCalledExactlyOnceWith(
    "clearCookies",
    { profileId: "default" },
    expect.any(AbortSignal),
  );
});

it("marks the opened popup as an allowed browser-surface overlay", async () => {
  const PageMenu = await loadPageMenu();
  await act(async () =>
    root.render(
      <TooltipProvider delay={0}>
        <PageMenu {...pageMenuProps()} />
      </TooltipProvider>,
    ),
  );
  await openPageMenu();
  expect(
    document.querySelector('[role="menu"]')!.hasAttribute(BROWSER_SURFACE_OVERLAY_ATTRIBUTE),
  ).toBe(true);
});

it("points closed directories right and expanded directories down", async () => {
  await act(async () =>
    root.render(<testKit.TreeRow path="src" depth={0} directory expanded={false} />),
  );
  expect(container.querySelector("svg")!.classList.contains("-rotate-90")).toBe(true);
  await act(async () => root.render(<testKit.TreeRow path="src" depth={0} directory expanded />));
  expect(container.querySelector("svg")!.classList.contains("rotate-90")).toBe(false);
  expect(container.querySelector("svg")!.classList.contains("-rotate-90")).toBe(false);
});

it("ignores future icon names instead of failing the surface", async () => {
  await act(async () => root.render(<testKit.Icon name={"download" as "back"} />));
  expect(container.innerHTML).toBe("");
});

it("uses the native refreshing glyph state", async () => {
  await act(async () => root.render(<testKit.Icon name="refresh" refreshing />));
  expect(
    container.querySelector("svg")!.classList.contains("motion-safe:visible-animate-spin"),
  ).toBe(true);
});

it("closes a third-party portal when its retained extension surface hides", async () => {
  const host = createExtensionHost<SurfaceRenderer>({ authorize: () => true });
  function Renderer() {
    const [open, setOpen] = React.useState(true);
    return (
      <testKit.Menu open={open} onOpenChange={setOpen}>
        <testKit.MenuTrigger>
          <testKit.Button aria-label="Preview menu">More</testKit.Button>
        </testKit.MenuTrigger>
        <testKit.MenuPopup>
          <testKit.MenuItem>Action</testKit.MenuItem>
        </testKit.MenuPopup>
      </testKit.Menu>
    );
  }
  host.register({
    manifest: {
      id: "test.kit",
      apiVersion: 1,
      version: "1.0.0",
      surfaces: [
        {
          id: "test.kit/view",
          title: "Kit",
          placements: ["side-panel"],
          clients: ["web"],
          scope: "environment",
          capabilities: [],
          stateVersion: 1,
        },
      ],
    },
    surfaces: [
      {
        id: "test.kit/view",
        validateRestore: () => true,
        createView: () => ({ renderer: Renderer }),
      },
    ],
  });
  const viewId = await host.open({
    version: 1,
    surfaceId: "test.kit/view",
    placement: "side-panel",
    stateVersion: 1,
    restoreState: null,
    fallback: "Unavailable",
    context: {
      client: "web",
      resource: { namespace: "test.kit", id: "one", environmentId: "env" },
    },
  });
  await host.show(viewId);
  expect(host.snapshot(viewId).status).toBe("ready");
  await act(async () => root.render(<ExtensionSurface host={host} viewId={viewId} />));
  const trigger = container.querySelector<HTMLButtonElement>('[aria-label="Preview menu"]')!;
  expect(document.querySelector('[role="menu"]')).not.toBeNull();
  await act(async () => host.hide(viewId));
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
  expect(document.querySelector('[role="menu"]')).toBeNull();
  await act(async () => host.show(viewId));
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
  await act(async () => host.close(viewId));
});

it("matches the native page menu order and reported zoom display", async () => {
  const PageMenu = await loadPageMenu();
  await act(async () =>
    root.render(
      <TooltipProvider delay={0}>
        <PageMenu {...pageMenuProps()} />
      </TooltipProvider>,
    ),
  );
  await openPageMenu();
  const labels = Array.from(
    document.querySelector('[role="menu"]')!.querySelectorAll('[role="menuitem"]'),
  ).map((item) => item.textContent);
  expect(labels.slice(0, 4)).toEqual([
    "Hard reload",
    "Open DevTools",
    "Open separate preview window",
    "Show device toolbar",
  ]);
  expect(document.querySelector('select[aria-label="Zoom level"]')).toBeNull();
  expect(document.querySelector('[role="menu"]')!.textContent).toContain("100%");
});

it("keeps generic inputs independent of Browser defaults and preserves HTML size", async () => {
  await act(async () =>
    root.render(
      <testKit.InputGroup>
        <testKit.Input size={42} />
      </testKit.InputGroup>,
    ),
  );
  const group = container.querySelector('[data-slot="input-group"]')!;
  expect(group.classList.contains("h-7")).toBe(false);
  expect(group.classList.contains("flex-1")).toBe(false);
  expect(group.classList.contains("bg-transparent")).toBe(false);
  expect(container.querySelector("input")!.getAttribute("size")).toBe("42");
});

it("keeps generic popup positioning independent of Browser defaults", async () => {
  await act(async () =>
    root.render(
      <testKit.Menu open={true} onOpenChange={vi.fn()}>
        <testKit.MenuTrigger>
          <testKit.Button>Generic menu</testKit.Button>
        </testKit.MenuTrigger>
        <testKit.MenuPopup>
          <testKit.MenuItem>Generic action</testKit.MenuItem>
        </testKit.MenuPopup>
      </testKit.Menu>,
    ),
  );
  expect(document.querySelector('[data-slot="menu-positioner"]')!.getAttribute("data-align")).toBe(
    "center",
  );
});

it("keeps the native external-address addon reachable until editing starts", async () => {
  const addressPath = "../../../../packages/first-party-extensions/browser/addressInput.tsx";
  const {
    AddressInput,
  }: {
    AddressInput: React.ComponentType<{
      host: Pick<ClientHost, "uiKit">;
      value: string;
      committed: string;
      onValueChange: (value: string) => void;
      onSubmit: (value: string) => void;
      inputRef: React.Ref<HTMLInputElement>;
      style: React.CSSProperties;
      addon: React.ReactNode;
    }>;
  } = await import(new URL(addressPath, import.meta.url).pathname);
  const opened = vi.fn();
  await act(async () =>
    root.render(
      <AddressInput
        host={{ uiKit: testKit }}
        value="https://example.test"
        committed="https://example.test"
        onValueChange={vi.fn()}
        onSubmit={vi.fn()}
        inputRef={null}
        style={{}}
        addon={
          <testKit.Button aria-label="Open in system browser" onClick={opened}>
            Open
          </testKit.Button>
        }
      />,
    ),
  );
  const input = container.querySelector("input")!;
  const button = container.querySelector<HTMLButtonElement>(
    '[aria-label="Open in system browser"]',
  )!;
  expect(button.closest('[data-slot="input-group"]')).toBe(
    input.closest('[data-slot="input-group"]'),
  );
  expect(button.parentElement!.classList.contains("group-hover/extension-input:opacity-100")).toBe(
    true,
  );
  expect(button.parentElement!.classList.contains("transition-opacity")).toBe(true);
  await act(async () => button.click());
  expect(opened).toHaveBeenCalledOnce();
  await act(async () => input.focus());
  expect(container.querySelector('[aria-label="Open in system browser"]')).toBeNull();
  await act(async () => input.blur());
  expect(container.querySelector('[aria-label="Open in system browser"]')).not.toBeNull();
});

it("shows native pressed chrome while annotation is active and can cancel", async () => {
  const path = "../../../../packages/first-party-extensions/browser/annotateButton.tsx";
  const {
    AnnotateButton,
  }: {
    AnnotateButton: React.ComponentType<{
      host: ClientHost;
      blockReason: string | null;
      capturing: "element";
      pageFailed: boolean;
      onPick: () => void;
      style: React.CSSProperties;
    }>;
  } = await import(new URL(path, import.meta.url).pathname);
  const cancel = vi.fn();
  await act(async () =>
    root.render(
      <TooltipProvider delay={0}>
        <AnnotateButton
          host={pageMenuProps().host as ClientHost}
          blockReason={null}
          capturing="element"
          pageFailed={false}
          onPick={cancel}
          style={{}}
        />
      </TooltipProvider>,
    ),
  );
  const button = container.querySelector<HTMLButtonElement>('[aria-label="Cancel annotation"]')!;
  expect(button.getAttribute("aria-pressed")).toBe("true");
  expect(button.classList.contains("bg-secondary")).toBe(true);
  expect(button.querySelector("svg")!.classList.contains("text-primary")).toBe(true);
  await act(async () => button.click());
  expect(cancel).toHaveBeenCalledOnce();
});

it("renders the real Browser chrome in native order without changing the older-host order", async () => {
  const browserPath = "../../../../packages/first-party-extensions/browser/extension.tsx";
  for (const native of [true, false]) {
    const extensionHost = createExtensionHost<SurfaceRenderer>({ authorize: () => true });
    const {
      default: browser,
    }: {
      default: {
        client(host: ClientHost): Parameters<typeof extensionHost.register>[0];
      };
    } = await import(new URL(browserPath, import.meta.url).pathname);
    const clientHost = {
      React,
      tooltip: hostTooltip,
      ...(native ? { uiKit: testKit } : {}),
      invokeApi: () => Promise.reject(new Error("Environment is not connected")),
      subscribeApi: async function* () {},
      discoverApis: async () => [],
    } as unknown as ClientHost;
    extensionHost.register(browser.client(clientHost));
    const viewId = await extensionHost.open({
      version: 1,
      surfaceId: "t3.browser/view",
      placement: "side-panel",
      stateVersion: 1,
      restoreState: null,
      fallback: "Browser unavailable",
      context: {
        client: "web",
        resource: {
          namespace: "t3.extensions",
          id: "t3.browser",
          environmentId: "env",
          projectId: "project",
          threadId: "thread",
        },
      },
    });
    await act(async () =>
      root.render(
        <TooltipProvider delay={0}>
          <ExtensionSurface host={extensionHost} viewId={viewId} />
        </TooltipProvider>,
      ),
    );
    const address = container.querySelector<HTMLInputElement>('[aria-label="Address"]')!;
    expect(address).not.toBeNull();
    const chrome = native
      ? (container.querySelector("[data-surface-subheader]") ?? container.querySelector("header"))!
      : container.querySelector("header")!;
    const labels = Array.from(chrome.querySelectorAll("button")).map((button) =>
      button.getAttribute("aria-label"),
    );
    expect(labels).toEqual(
      native
        ? [
            "Back",
            "Forward",
            "Refresh",
            "Open in system browser",
            "Annotate preview",
            "Capture screenshot",
            "Preview menu",
          ]
        : [
            "Back",
            "Forward",
            "Refresh",
            "Show device toolbar",
            "Capture screenshot",
            "Annotate preview",
            "Open in system browser",
            "Preview menu",
          ],
    );
    if (native) {
      const external = chrome.querySelector('[aria-label="Open in system browser"]')!;
      expect(external.closest('[data-slot="input-group"]')).toBe(
        address.closest('[data-slot="input-group"]'),
      );
      expect(
        container.querySelector('[aria-label="Navigation"]')!.classList.contains("gap-0.5"),
      ).toBe(true);
    }
    const back = chrome.querySelector<HTMLButtonElement>('[aria-label="Back"]')!;
    back.removeAttribute("data-slot");
    const rule = container.querySelector("style")!.sheet!.cssRules[0] as CSSStyleRule;
    expect(back.matches(rule.selectorText.replace(":focus-visible", ""))).toBe(!native);
    await act(async () => {
      root.render(null);
      await extensionHost.close(viewId);
    });
  }
});

it("uses native recording chrome and allows stopping after the page fails", async () => {
  const path = "../../../../packages/first-party-extensions/browser/annotateButton.tsx";
  const {
    ScreenshotButton,
  }: {
    ScreenshotButton: React.ComponentType<{
      host: ClientHost;
      blockReason: string | null;
      capturing: null;
      pageFailed: boolean;
      recording: boolean;
      onCapture: (record: boolean) => void;
      style: React.CSSProperties;
    }>;
  } = await import(new URL(path, import.meta.url).pathname);
  const stop = vi.fn();
  await act(async () =>
    root.render(
      <TooltipProvider delay={0}>
        <ScreenshotButton
          host={pageMenuProps().host as ClientHost}
          blockReason="Page failed"
          capturing={null}
          pageFailed
          recording
          onCapture={stop}
          style={{}}
        />
      </TooltipProvider>,
    ),
  );
  const button = container.querySelector<HTMLButtonElement>('[aria-label="Stop recording"]')!;
  expect(button.classList.contains("bg-secondary")).toBe(true);
  expect(button.querySelector("svg")?.classList.contains("text-destructive")).toBe(true);
  expect(button.querySelector("[data-t3-recording-indicator]")).not.toBeNull();
  expect(button.disabled).toBe(false);
  await act(async () => button.click());
  expect(stop).toHaveBeenCalledExactlyOnceWith(false);
});

it("chooses cookie import sources and profiles with native menu keys", async () => {
  const PageMenu = await loadPageMenu();
  const path = "../../../../packages/first-party-extensions/browser/profileMenu.tsx";
  const { ProfileSection }: { ProfileSection: React.ComponentType<ProfileSectionProps> } =
    await import(new URL(path, import.meta.url).pathname);
  const sources = [
    { id: "chrome", name: "Chrome", profiles: [{ handle: "default", name: "Personal" }] },
    {
      id: "firefox",
      name: "Firefox",
      profiles: [
        { handle: "work", name: "Work" },
        { handle: "personal", name: "Personal" },
      ],
    },
  ];
  const invoke = vi.fn().mockResolvedValue({ sources });
  const snapshot = { list: null, error: null };
  const profiles = { subscribe: () => () => {}, getSnapshot: () => snapshot, refresh: vi.fn() };
  const props = pageMenuProps();
  await act(async () =>
    root.render(
      <TooltipProvider delay={0}>
        <PageMenu {...props}>
          {(close) => (
            <ProfileSection
              host={props.host}
              session={props.session!}
              api={{ invoke }}
              profiles={profiles}
              signal={new AbortController().signal}
              onOpenInProfile={vi.fn()}
              report={vi.fn()}
              onChosen={close}
            />
          )}
        </PageMenu>
      </TooltipProvider>,
    ),
  );
  await openPageMenu();
  const importer = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]')).find(
    (item) => item.textContent === "Import cookies…",
  )!;
  await act(async () => importer.click());
  expect(document.querySelector('[role="menu"] select')).toBeNull();
  const profileGroup = document
    .querySelector('[title="Profile: Default"]')!
    .closest('[data-slot="menu-group"]')!;
  expect(profileGroup.hasAttribute("aria-labelledby")).toBe(false);
  expect(profileGroup.getAttribute("aria-label")).toBe("Profile");
  for (const label of ["Import from browser", "Import from browser profile"]) {
    const heading = Array.from(document.querySelectorAll('[data-slot="menu-label"]')).find(
      (node) => node.textContent === label,
    )!;
    expect(heading.closest('[role="group"]')?.getAttribute("aria-labelledby")).toBe(heading.id);
  }
  const radios = () => Array.from(document.querySelectorAll<HTMLElement>('[role="menuitemradio"]'));
  const firefox = radios().find((item) => item.textContent === "Firefox")!;
  expect(firefox).toBeDefined();
  const chrome = radios().find((item) => item.textContent === "Chrome")!;
  await act(async () => {
    chrome.focus();
    chrome.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
  });
  expect(document.activeElement).toBe(firefox);
  await act(async () =>
    firefox.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })),
  );
  expect(
    radios()
      .find((item) => item.textContent === "Firefox")
      ?.getAttribute("aria-checked"),
  ).toBe("true");
  expect(document.querySelector('[role="menu"]')).not.toBeNull();
  const personal = radios().find((item) => item.textContent === "Personal")!;
  await act(async () => {
    personal.focus();
    personal.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
  const run = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]')).find(
    (item) => item.textContent === "Import into Default",
  )!;
  invoke.mockClear();
  await act(async () => run.click());
  expect(invoke).toHaveBeenCalledExactlyOnceWith(
    "importCookies",
    { profileId: "default", sourceId: "firefox", sourceProfile: "personal" },
    expect.any(AbortSignal),
  );
});

it("profile fallback actions do not submit an enclosing form", async () => {
  const path = "../../../../packages/first-party-extensions/browser/profileMenu.tsx";
  const { ProfileSection }: { ProfileSection: React.ComponentType<ProfileSectionProps> } =
    await import(new URL(path, import.meta.url).pathname);
  const invoke = vi.fn().mockResolvedValue({ cleared: true });
  const submit = vi.fn((event: React.FormEvent) => event.preventDefault());
  const snapshot = { list: null, error: null };
  await act(async () =>
    root.render(
      <form onSubmit={submit}>
        <ProfileSection
          host={{}}
          session={pageMenuProps().session!}
          api={{ invoke }}
          profiles={{ subscribe: () => () => {}, getSnapshot: () => snapshot, refresh: vi.fn() }}
          signal={new AbortController().signal}
          onOpenInProfile={vi.fn()}
          report={vi.fn()}
          onChosen={vi.fn()}
        />
      </form>,
    ),
  );
  const clear = Array.from(container.querySelectorAll("button")).find(
    (node) => node.textContent === "Clear cookies",
  )!;
  await act(async () => clear.click());
  expect(invoke).toHaveBeenCalledExactlyOnceWith(
    "clearCookies",
    { profileId: "default" },
    expect.any(AbortSignal),
  );
  expect(submit).not.toHaveBeenCalled();
});

it("mini-player kit and fallback controls track native open state and preserve toggling", async () => {
  const path = "../../../../packages/first-party-extensions/browser/miniPlayer.tsx";
  const {
    MiniPlayerButton,
  }: {
    MiniPlayerButton: React.ComponentType<{
      host: ClientHost;
      session: ViewSession;
      held: { tabId: string; serverEpoch: string };
      visible: boolean;
      available: boolean;
      style: React.CSSProperties;
      report: (message: string) => void;
    }>;
  } = await import(new URL(path, import.meta.url).pathname);
  for (const native of [true, false]) {
    let active: string | null = null;
    const listeners = new Set<() => void>();
    const toggle = vi.fn(async (request: { method: string; input: { open: boolean } }) => {
      if (request.method === "getCapabilities")
        return { operations: { setBrowserMiniPlayer: true, getBrowserMiniPlayer: true } };
      active = request.input.open ? "tab" : null;
      for (const listener of listeners) listener();
      return { tabId: active };
    });
    const host = {
      React,
      tooltip: hostTooltip,
      ...(native ? { uiKit: testKit } : {}),
      browserMiniPlayer: {
        supported: true,
        canFloat: () => true,
        read: () => active,
        subscribe: (_context: unknown, listener: () => void) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },
      discoverApis: async () => [{ id: "t3.ui/panels", version: "1.1.0" }],
      invokeApi: toggle,
    } as unknown as ClientHost;
    await act(async () =>
      root.render(
        <TooltipProvider delay={0}>
          <MiniPlayerButton
            host={host}
            session={
              {
                context: {
                  client: "desktop",
                  resource: {
                    namespace: "t3.browser",
                    id: "view",
                    environmentId: "env",
                    projectId: "project",
                    threadId: "thread",
                  },
                },
                signal: new AbortController().signal,
              } as React.ComponentProps<typeof MiniPlayerButton>["session"]
            }
            held={{ tabId: "tab", serverEpoch: "epoch" }}
            visible
            available
            style={{ padding: 4 }}
            report={vi.fn()}
          />
        </TooltipProvider>,
      ),
    );
    let button = container.querySelector<HTMLButtonElement>(
      '[aria-label="Float preview over chat"]',
    )!;
    if (native) {
      expect(button.classList.contains("sm:size-6")).toBe(true);
      expect(button.style.padding).toBe("");
    } else {
      expect(button.hasAttribute("data-t3-browser-fallback-control")).toBe(true);
      expect(button.style.padding).toBe("4px");
    }
    expect(button.disabled).toBe(false);
    await act(async () => button.click());
    expect(toggle.mock.calls).toHaveLength(1);
    button = container.querySelector<HTMLButtonElement>('[aria-label="Close floating preview"]')!;
    expect(button.getAttribute("aria-pressed")).toBe("true");
    expect(button.getAttribute("aria-label")).toBe("Close floating preview");
    if (native) {
      const packClasses = Array.from(button.classList);
      expect(packClasses).toContain("[--control-icon-color:var(--color-primary)]");
      // Compare the real kit control to native, including the secondary variant.
      const comparator = document.createElement("div");
      container.append(comparator);
      const comparatorRoot = createRoot(comparator);
      await act(async () =>
        comparatorRoot.render(
          <TooltipProvider delay={0}>
            <PreviewChromeRow
              url="https://example.com"
              loading={false}
              canGoBack={false}
              canGoForward={false}
              refreshDisabled={false}
              onBack={vi.fn()}
              onForward={vi.fn()}
              onRefresh={vi.fn()}
              onSubmit={vi.fn()}
              onPictureInPicture={vi.fn()}
              pictureInPicture
            />
          </TooltipProvider>,
        ),
      );
      const nativeButton = comparator.querySelector('[aria-label="Close floating preview"]')!;
      expect(nativeButton.querySelector("svg")!.classList.contains("text-primary")).toBe(true);
      expect(
        packClasses.filter((token) => !token.startsWith("[--control-icon-color:")).sort(),
      ).toEqual(
        Array.from(nativeButton.classList)
          .filter((token) => !token.startsWith("[--control-icon-color:"))
          .sort(),
      );
      await act(async () => comparatorRoot.unmount());
      comparator.remove();
    } else {
      expect(button.style.color).toBe("var(--primary)");
    }
    await act(async () => button.click());
    button = container.querySelector<HTMLButtonElement>('[aria-label="Float preview over chat"]')!;
    expect(button.getAttribute("aria-pressed")).toBe("false");
    expect(button.classList.contains("[--control-icon-color:var(--color-primary)]")).toBe(false);
    expect(
      toggle.mock.calls.filter(([request]) => request.method === "setBrowserMiniPlayer"),
    ).toHaveLength(2);
    await act(async () => root.render(null));
  }
});
