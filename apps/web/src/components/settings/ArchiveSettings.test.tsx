import { renderToStaticMarkup } from "react-dom/server";
import type { ComponentProps, Ref } from "react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const testDoubles = vi.hoisted(() => ({
  inputRef: null as Ref<HTMLInputElement> | null,
  navigate: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({
  useLocation: ({ select }: { select: (location: { hash: string }) => unknown }) =>
    select({ hash: "#archive" }),
  useNavigate: () => testDoubles.navigate,
}));

vi.mock("../ui/input", () => ({
  Input: ({
    ref,
    nativeInput: _nativeInput,
    ...inputProps
  }: ComponentProps<"input"> & { nativeInput?: boolean; ref?: Ref<HTMLInputElement> }) => {
    testDoubles.inputRef = ref ?? null;
    return <input {...inputProps} />;
  },
}));

vi.mock("../../hooks/useSettings", () => ({
  useClientSettings: (selector: (settings: { confirmThreadDelete: boolean }) => unknown) =>
    selector({ confirmThreadDelete: true }),
}));

vi.mock("../../hooks/useThreadActions", () => ({
  useThreadActions: () => ({
    deleteThread: vi.fn(),
    unarchiveThread: vi.fn(),
  }),
}));

vi.mock("../../state/environments", () => ({
  useEnvironments: () => ({ environments: [] }),
  usePrimaryEnvironmentId: () => null,
}));

vi.mock("../../lib/archivedThreadsState", () => ({
  useArchivedThreadSnapshots: () => ({
    snapshots: [],
    error: null,
    isLoading: false,
    refresh: vi.fn(),
  }),
}));

import { ArchivedThreadsPanel } from "./ArchiveSettings";

afterEach(() => {
  testDoubles.inputRef = null;
  testDoubles.navigate.mockReset();
  vi.unstubAllGlobals();
});

describe("ArchivedThreadsPanel", () => {
  it("focuses the persistent archive search field selected by settings search", () => {
    const scrollIntoView = vi.fn();
    const focus = vi.fn();
    const classList = { remove: vi.fn(), add: vi.fn() };
    const addEventListener = vi.fn();
    vi.stubGlobal("window", {
      matchMedia: vi.fn(() => ({ matches: false })),
    });

    const markup = renderToStaticMarkup(<ArchivedThreadsPanel />);
    const archiveInput = {
      tagName: "INPUT",
      firstElementChild: null,
      scrollIntoView,
      focus,
      classList,
      addEventListener,
      offsetWidth: 100,
    } as unknown as HTMLInputElement;

    if (typeof testDoubles.inputRef !== "function") {
      throw new Error("Expected the archive input to receive a callback ref");
    }
    testDoubles.inputRef(archiveInput);

    expect(markup).toContain('id="archive"');
    expect(markup).toContain('aria-label="Search archived conversations"');
    expect(markup).toContain(">Archived threads</h2>");
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: "smooth", block: "center" });
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(classList.remove).toHaveBeenCalledWith("settings-search-target-pulse");
    expect(classList.add).toHaveBeenCalledWith("settings-search-target-pulse");
    expect(testDoubles.navigate).toHaveBeenCalledWith({
      hash: "",
      replace: true,
      resetScroll: false,
      hashScrollIntoView: false,
    });
  });
});
