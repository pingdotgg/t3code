import { EnvironmentId, ThreadId, type ChatFileAttachment } from "@t3tools/contracts";
import { createExtensionHost } from "@t3tools/extension-sdk/host";
import { ExtensionSurface, type SurfaceRenderer } from "@t3tools/extension-sdk/react";
import type { ViewRecord } from "@t3tools/extension-sdk/contracts";
import { act, createContext, useContext, useEffect, useState, type ComponentProps } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import FilePreviewPanel from "../../components/files/FilePreviewPanel";
import { createFilesExtension, type FilesBindings } from "./filesExtension";

// Stateful domain double shared by baseline and candidate. This tests composition
// ownership, not Pierre editing, filesystem RPC, or browser rendering parity.
vi.mock("../../components/files/FilePreviewPanel", () => ({
  default: function StatefulFileEngine(props: ComponentProps<typeof FilePreviewPanel>) {
    const [draft, setDraft] = useState("clean");
    const [explorer, setExplorer] = useState(true);
    useEffect(() => {
      activity.mounts++;
      return () => {
        activity.unmounts++;
      };
    }, []);
    return (
      <section>
        <output>
          {JSON.stringify({
            environmentId: props.environmentId,
            cwd: props.cwd,
            path: props.relativePath,
            attachment: props.attachment?.id ?? null,
            reveal: [props.revealLine, props.revealRequestId],
            revision: props.workspaceMutationId,
            pending: props.selectedFilePending,
            draft,
            explorer,
          })}
        </output>
        <button
          aria-label="Edit"
          onClick={() => {
            setDraft("unsaved change");
            props.onPendingChange(props.relativePath ?? "", true);
          }}
        />
        <button aria-label="Select file" onClick={() => props.onOpenFile("deep/src/next.ts")} />
        <button aria-label="Toggle explorer" onClick={() => setExplorer(!explorer)} />
      </section>
    );
  },
}));
const activity = vi.hoisted(() => ({ mounts: 0, unmounts: 0 }));
const BindingContext = createContext<FilesBindings | null>(null);
function useBindings() {
  const value = useContext(BindingContext);
  if (!value) throw new Error("Files bindings missing");
  return value;
}

// Frozen ChatView composition at baseline 3e6f856f, with variables supplied by
// the same context fixture. Keep this independent from the extension renderer.
function Baseline() {
  const b = useBindings();
  const s = b.surface;
  if (!((b.hasProject && b.cwd) || (s.kind === "file" && s.attachment))) return null;
  return (
    <FilePreviewPanel
      key={`${b.environmentId}:${s.kind === "file" && s.attachment ? `attachment:${s.attachment.id}` : b.cwd}`}
      environmentId={b.environmentId}
      cwd={b.cwd}
      projectName={b.projectName}
      threadRef={b.threadRef}
      composerDraftTarget={b.composerDraftTarget}
      keybindings={b.keybindings}
      availableEditors={b.availableEditors}
      relativePath={s.kind === "file" ? s.relativePath : null}
      {...(s.kind === "file" && s.attachment ? { attachment: s.attachment } : {})}
      revealLine={s.kind === "file" ? (s.revealLine ?? null) : null}
      revealRequestId={s.kind === "file" ? s.revealRequestId : 0}
      onOpenFile={b.onOpenFile}
      onPendingChange={b.onPendingChange}
      selectedFilePending={b.selectedFilePending}
      workspaceMutationId={b.workspaceMutationId}
    />
  );
}
function initialBindings(): FilesBindings {
  const threadRef = {
    environmentId: EnvironmentId.make("east"),
    threadId: ThreadId.make("thread"),
  };
  return {
    environmentId: threadRef.environmentId,
    cwd: "/fixtures/workspace",
    projectName: "Fixture",
    threadRef,
    composerDraftTarget: threadRef,
    keybindings: [],
    availableEditors: [],
    surface: { kind: "files", id: "files" },
    hasProject: true,
    onOpenFile: () => {},
    onPendingChange: () => {},
    selectedFilePending: false,
    workspaceMutationId: null,
  };
}
const record = (surfaceId = "t3.files/view"): ViewRecord => ({
  version: 1,
  surfaceId,
  context: {
    client: "web",
    resource: {
      namespace: "t3.files",
      id: "fixture",
      environmentId: "east",
      projectId: "project",
      threadId: "thread",
    },
  },
  placement: "side-panel",
  stateVersion: 1,
  restoreState: null,
  fallback: "Files unavailable",
});
const roots: ReactTestRenderer[] = [];
afterEach(async () => {
  await act(() => {
    for (const root of roots) root.unmount();
  });
  roots.length = 0;
  vi.unstubAllGlobals();
});

async function mount(
  registered: boolean,
  initial = initialBindings(),
  surfaceId = "t3.files/view",
) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = createExtensionHost<SurfaceRenderer>({ authorize: () => true });
  host.register(createFilesExtension(useBindings));
  const id = await host.open(record(surfaceId));
  let bindings = initial;
  const render = () => (
    <BindingContext value={bindings}>
      {registered ? <ExtensionSurface host={host} viewId={id} /> : <Baseline />}
    </BindingContext>
  );
  let root!: ReactTestRenderer;
  await act(async () => {
    root = create(render());
  });
  roots.push(root);
  return {
    host,
    id,
    root,
    read: () => root.root.findAllByType("output").map((o) => JSON.parse(o.children.join(""))),
    update: async (next: Partial<FilesBindings>) => {
      bindings = { ...bindings, ...next };
      await act(() => root.update(render()));
    },
    click: async (label: string) =>
      act(() => root.root.findByProps({ "aria-label": label }).props.onClick()),
  };
}
describe("registered native Files composition", () => {
  it("matches baseline selection, unsaved state, reveal, refresh and scoped remount", async () => {
    async function journey(registered: boolean) {
      const events: string[] = [];
      const f = await mount(registered, {
        ...initialBindings(),
        onOpenFile: (path) => events.push("open:" + path),
        onPendingChange: (path, pending) => events.push(`pending:${path}:${pending}`),
      });
      const snapshots = [f.read()];
      await f.click("Select file");
      await f.update({
        surface: {
          kind: "file",
          id: "file:deep/src/next.ts",
          relativePath: "deep/src/next.ts",
          revealLine: 9,
          revealRequestId: 1,
        },
      });
      await f.click("Edit");
      await f.click("Toggle explorer");
      snapshots.push(f.read());
      await f.update({ selectedFilePending: true, workspaceMutationId: "mutation-2" });
      snapshots.push(f.read());
      await f.update({
        surface: {
          kind: "file",
          id: "file:README.md",
          relativePath: "README.md",
          revealLine: null,
          revealRequestId: 2,
        },
      });
      snapshots.push(f.read());
      await f.update({ cwd: "/fixtures/replacement" });
      snapshots.push(f.read());
      const west = EnvironmentId.make("west");
      await f.update({
        environmentId: west,
        threadRef: { environmentId: west, threadId: ThreadId.make("thread") },
      });
      snapshots.push(f.read());
      await act(() => f.root.unmount());
      f.host.dispose();
      return { events, snapshots };
    }
    const baseline = await journey(false);
    const candidate = await journey(true);
    expect(candidate).toEqual(baseline);
    expect(candidate.events).toEqual(["open:deep/src/next.ts", "pending:deep/src/next.ts:true"]);
    expect(candidate.snapshots[3]?.[0]).toMatchObject({ draft: "unsaved change", explorer: false });
    expect(candidate.snapshots[4]?.[0]).toMatchObject({ draft: "clean", explorer: true });
  });
  it("preserves attachment availability without project and resets between attachment resources", async () => {
    const attachment = {
      id: "report-1",
      type: "file",
      name: "report.pdf",
      mimeType: "application/pdf",
      sizeBytes: 7,
    } satisfies ChatFileAttachment;
    async function journey(registered: boolean) {
      const f = await mount(
        registered,
        { ...initialBindings(), cwd: "", hasProject: false },
        "t3.files/file",
      );
      const snapshots = [f.read()];
      await f.update({
        surface: {
          kind: "file",
          id: "attachment:report-1",
          relativePath: "report.pdf",
          revealLine: null,
          revealRequestId: 0,
          attachment,
        },
      });
      await f.click("Edit");
      snapshots.push(f.read());
      await f.update({
        surface: {
          kind: "file",
          id: "attachment:report-2",
          relativePath: "report.pdf",
          revealLine: null,
          revealRequestId: 0,
          attachment: { ...attachment, id: "report-2" },
        },
      });
      snapshots.push(f.read());
      await act(() => f.root.unmount());
      f.host.dispose();
      return snapshots;
    }
    const candidate = await journey(true);
    expect(candidate).toEqual(await journey(false));
    expect(candidate[0]).toEqual([]);
    expect(candidate[1]?.[0]).toMatchObject({ attachment: "report-1", draft: "unsaved change" });
    expect(candidate[2]?.[0]).toMatchObject({ attachment: "report-2", draft: "clean" });
  });
  it("keeps editor instance while hidden and cleans it up on disable", async () => {
    const f = await mount(true);
    await f.click("Edit");
    const mounted = activity.mounts;
    await act(() => f.host.hide(f.id));
    await act(() => f.host.show(f.id));
    expect(f.read()[0]).toMatchObject({ draft: "unsaved change" });
    expect(activity.mounts).toBe(mounted);
    const unmounted = activity.unmounts;
    await act(() => f.host.disable("t3.files"));
    expect(f.read()).toEqual([]);
    expect(activity.unmounts).toBe(unmounted + 1);
    f.host.enable("t3.files");
    await act(() => f.host.show(f.id));
    expect(f.read()[0]).toMatchObject({ draft: "clean" });
    await act(() => f.root.unmount());
    f.host.dispose();
    expect(f.host.diagnostics()).toMatchObject({ views: 0, pendingCalls: 0 });
  });
});

it("drains 100 repeated registered view lifecycles without retaining engine mounts", async () => {
  const before = activity.mounts - activity.unmounts;
  for (let cycle = 0; cycle < 100; cycle++) {
    const f = await mount(true);
    await f.click("Edit");
    await act(() => f.host.hide(f.id));
    await act(() => f.host.show(f.id));
    expect(f.read()[0]).toMatchObject({ draft: "unsaved change" });
    await act(() => f.host.close(f.id));
    expect(f.read()).toEqual([]);
    await act(() => f.root.unmount());
    f.host.dispose();
    expect(f.host.diagnostics()).toMatchObject({ views: 0, pendingCalls: 0, listeners: 0 });
  }
  expect(activity.mounts - activity.unmounts).toBe(before);
});
