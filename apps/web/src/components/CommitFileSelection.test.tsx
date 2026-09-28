import { useState, type ReactNode } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { CommitFileSelection } from "./CommitFileSelection";
import { Checkbox } from "./ui/checkbox";

// Keep selection and preference state real; omit DOM-only positioning primitives.
vi.mock("./ui/scroll-area", () => ({
  ScrollArea: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("./ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => children,
  TooltipTrigger: ({ children }: { children: ReactNode }) => children,
  TooltipPopup: () => null,
}));
vi.mock("./ui/checkbox", () => ({ Checkbox: () => null }));

const files = [
  { path: "src/a.ts", insertions: 2, deletions: 1 },
  { path: "src/b.ts", insertions: 3, deletions: 0 },
  { path: "README.md", insertions: 1, deletions: 0 },
];

function Selection() {
  const [excluded, setExcluded] = useState<ReadonlySet<string>>(new Set());
  const [editing, setEditing] = useState(true);
  return (
    <CommitFileSelection
      files={files}
      excludedFiles={excluded}
      isEditing={editing}
      onExcludedFilesChange={setExcluded}
      onEditingChange={setEditing}
      onOpenFile={() => {}}
      canOpenFile={true}
    />
  );
}

describe("commit file selection", () => {
  let renderer: ReactTestRenderer;
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const values = new Map<string, string>();
    const target = new EventTarget();
    vi.stubGlobal(
      "window",
      Object.assign(target, {
        localStorage: {
          getItem: (key: string) => values.get(key) ?? null,
          setItem: (key: string, value: string) => values.set(key, value),
        },
      }),
    );
  });
  afterEach(async () => {
    await act(async () => renderer?.unmount());
    vi.unstubAllGlobals();
  });
  const checkbox = (label: string) =>
    renderer.root.findAllByType(Checkbox).find((node) => node.props["aria-label"] === label)!;
  const groupToggle = () =>
    renderer.root.findAllByType(Checkbox).find((node) => !node.props["aria-label"])!;
  const folder = () => renderer.root.findByProps({ "aria-label": "src" });

  it("keeps selection when switching views and selecting collapsed folders", async () => {
    await act(async () => {
      renderer = create(<Selection />);
    });
    await act(async () => checkbox("Include src/a.ts").props.onCheckedChange(false));
    await act(async () => groupToggle().props.onCheckedChange(true));
    expect(checkbox("Include directory src").props.indeterminate).toBe(true);
    await act(async () => folder().props.onClick());
    expect(renderer.root.findAllByProps({ "aria-label": "Open src/a.ts" })).toHaveLength(0);
    await act(async () => checkbox("Include directory src").props.onCheckedChange(true));
    expect(checkbox("Include directory src").props.checked).toBe(true);
    await act(async () => checkbox("Include directory src").props.onCheckedChange(false));
    expect(checkbox("Include README.md").props.checked).toBe(true);
    await act(async () => groupToggle().props.onCheckedChange(false));
    expect(checkbox("Include src/a.ts").props.checked).toBe(false);
    expect(checkbox("Include src/b.ts").props.checked).toBe(false);
    await act(async () => groupToggle().props.onCheckedChange(true));
    await act(async () => folder().props.onClick());
    expect(renderer.root.findAllByProps({ "aria-label": "Open src/a.ts" })).toHaveLength(1);
  });

  it("remembers grouping when another commit dialog is opened", async () => {
    await act(async () => {
      renderer = create(<Selection />);
    });
    await act(async () => groupToggle().props.onCheckedChange(true));
    await act(async () => renderer.unmount());
    await act(async () => {
      renderer = create(<Selection />);
    });
    expect(groupToggle().props.checked).toBe(true);
    expect(folder().props["aria-expanded"]).toBe(true);
  });
});
