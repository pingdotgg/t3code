import { act, useImperativeHandle, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import { CommandPalette } from "./CommandPalette";
import { useComposerHandleContext } from "../composerHandleContext";
import { openCommandPalette } from "../commandPaletteBus";
import { primaryServerKeybindingsAtom } from "../state/server";

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => vi.fn(),
  useParams: () => null,
  useLocation: () => "/settings",
}));
vi.mock("@effect/atom-react", async (importOriginal) => {
  const original = await importOriginal<typeof import("@effect/atom-react")>();
  return {
    ...original,
    useAtomValue: (atom: unknown) =>
      atom === primaryServerKeybindingsAtom ? DEFAULT_RESOLVED_KEYBINDINGS : [],
  };
});
vi.mock("../hooks/useTheme", () => ({
  useRenderedAppearance: () => "light",
  useTheme: () => ({ theme: "default", resolvedTheme: "light", appearanceMode: "light" }),
}));
vi.mock("../hooks/useCustomThemes", () => ({ useCustomThemes: () => [] }));
vi.mock("../hooks/useEnvironmentTheme", () => ({ useEnvironmentThemeDefinitions: () => [] }));
vi.mock("../hooks/useSettings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../hooks/useSettings")>()),
  useClientSettings: () => ({}),
}));
vi.mock("../hooks/useScratchProject", () => ({
  useScratchProject: () => ({ scratchEnvironmentId: () => null }),
}));
vi.mock("../hooks/useNewProject", () => ({ useNewProject: () => vi.fn() }));
vi.mock("../hooks/useHandleNewThread", () => ({ useHandleNewThread: () => ({}) }));
vi.mock("../hooks/useOpenPanelPullRequestUrl", () => ({ useOpenPanelPullRequestUrl: () => null }));
vi.mock("../connection/useDesktopLocalBootstraps", () => ({ useDesktopLocalBootstraps: () => [] }));
vi.mock("../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("../state/use-atom-query-runner", () => ({ useAtomQueryRunner: () => vi.fn() }));
vi.mock("../state/environments", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/environments")>()),
  useEnvironments: () => ({ environments: [] }),
  usePrimaryEnvironmentId: () => null,
}));
vi.mock("../state/entities", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/entities")>()),
  useProjects: () => [],
  useThreadShells: () => [],
  useServerConfigs: () => new Map(),
}));
vi.mock("../state/queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/queries")>()),
  useThreadSearch: () => ({ matches: [] }),
}));
vi.mock("../state/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/session")>()),
  useEnvironmentScope: () => false,
}));
vi.mock("../state/query", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/query")>()),
  useEnvironmentQuery: () => ({}),
}));
vi.mock("./settings/useAvailableSettingsSearchItems", () => ({
  useAvailableSettingsSearchItems: () => [],
}));

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
    await vi.runOnlyPendingTimersAsync();
  });
  container.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function flushFocus() {
  await act(() => vi.advanceTimersByTimeAsync(0));
  await act(() => vi.advanceTimersToNextFrame());
}

async function dismissPalette() {
  await act(() =>
    document.activeElement?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    ),
  );
  await flushFocus();
  expect(document.querySelector("[data-command-palette]")).toBeNull();
}

function Composer() {
  const handle = useComposerHandleContext();
  const input = useRef<HTMLTextAreaElement>(null);
  useImperativeHandle(
    handle,
    () =>
      ({
        focusAtEnd: () => {
          input.current?.focus();
          input.current?.setSelectionRange(input.current.value.length, input.current.value.length);
        },
      }) as NonNullable<NonNullable<typeof handle>["current"]>,
  );
  return <textarea ref={input} aria-label="Composer" defaultValue="Draft prompt" />;
}

describe("command palette focus restoration", () => {
  it("returns to the previously focused Settings field when no composer is mounted", async () => {
    await act(() =>
      root.render(
        <CommandPalette>
          <input aria-label="Settings field" />
        </CommandPalette>,
      ),
    );
    const field = container.querySelector("input")!;
    await act(() => field.focus());
    await act(() => openCommandPalette());
    await flushFocus();
    expect(document.activeElement?.closest("[data-command-palette]")).not.toBeNull();
    await dismissPalette();
    expect(document.activeElement).toBe(field);
  });

  it("focuses the replacement command input after leaving the file picker", async () => {
    await act(() =>
      root.render(
        <CommandPalette>
          <input aria-label="Settings field" />
        </CommandPalette>,
      ),
    );
    const field = container.querySelector("input")!;
    await act(() => field.focus());
    await act(() =>
      field.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "p",
          ctrlKey: true,
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
    await flushFocus();
    expect(document.querySelector('[data-palette-mode="files"]')).not.toBeNull();
    await act(() =>
      document.activeElement?.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Escape",
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
    await flushFocus();
    expect(document.activeElement?.closest('[data-palette-mode="command"]')).not.toBeNull();
    expect(document.activeElement?.tagName).toBe("INPUT");
    await dismissPalette();
    expect(document.activeElement).toBe(field);
  });

  it("focuses the mounted composer at the end instead of the previous field", async () => {
    await act(() =>
      root.render(
        <CommandPalette>
          <input aria-label="Previous field" />
          <Composer />
        </CommandPalette>,
      ),
    );
    await act(() => container.querySelector("input")!.focus());
    await act(() => openCommandPalette());
    await flushFocus();
    expect(document.activeElement?.closest("[data-command-palette]")).not.toBeNull();
    await dismissPalette();
    const composer = container.querySelector("textarea")!;
    expect(document.activeElement).toBe(composer);
    expect(composer.selectionStart).toBe(composer.value.length);
  });
});
