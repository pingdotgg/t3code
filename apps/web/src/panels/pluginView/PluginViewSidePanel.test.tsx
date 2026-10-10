// @vitest-environment jsdom

import {
  EnvironmentId,
  PluginInstallationId,
  ThreadId,
  type PluginView,
  type PluginViewBundle,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import { AsyncResult, Atom } from "effect/reactivity";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { SessionPluginViews } from "~/state/pluginViewSessions";

const state = vi.hoisted(() => ({
  current: { session: null, views: null } as SessionPluginViews,
  listeners: new Set<() => void>(),
}));
vi.mock("~/state/pluginViews", async () => {
  const { useSyncExternalStore } = await import("react");
  const { AsyncResult: Result, Atom: A } = await import("effect/reactivity");
  const bundles = new Map<number, Atom.Atom<AsyncResult.AsyncResult<PluginViewBundle>>>();
  return {
    usePluginViews: () =>
      useSyncExternalStore(
        (listener) => {
          state.listeners.add(listener);
          return () => state.listeners.delete(listener);
        },
        () => state.current,
      ),
    pluginViewEnvironment: {
      // Each generation's consented bytes; the host must load the generation it mounts.
      bundle: ({ input }: { input: Pick<PluginViewBundle, "generation" | "installationId"> }) => {
        let atom = bundles.get(input.generation);
        if (!atom) {
          atom = A.make(
            Result.success<PluginViewBundle>({
              installationId: input.installationId,
              generation: input.generation,
              viewId: "board",
              sourceDigest: `digest-${input.generation}`,
              script: { text: `/* gen ${input.generation} */`, sha256: `hash-${input.generation}` },
              style: null,
            }),
          );
          bundles.set(input.generation, atom);
        }
        return atom;
      },
    },
  };
});
vi.mock("~/connection/runtime", () => ({
  connectionAtomRuntime: Atom.make(AsyncResult.success(Context.empty())),
}));

import { RegisteredSidePanel } from "../bundledPanels";
import { PanelHostContext, type PanelHost } from "../panelHost";
import { pluginViewSurfaceId, type PluginViewSurface } from "~/rightPanelStore";

const environmentId = EnvironmentId.make("environment-1");
const installationId = PluginInstallationId.make("installation-1");
const host: PanelHost = {
  threadRef: { environmentId, threadId: ThreadId.make("thread-1") },
  visible: true,
  composerDraftTarget: { environmentId, threadId: ThreadId.make("thread-1") },
  workspaceMutationId: null,
  sendAnnotation: () => {},
};
const surface: PluginViewSurface = {
  id: pluginViewSurfaceId({ installationId, viewId: "board" }),
  kind: "plugin-view",
  installationId,
  viewId: "board",
  title: "Board",
};
const view = (generation: number): PluginView => ({
  installationId,
  generation,
  pluginId: "test.views-board",
  pluginName: "Board",
  viewId: "board",
  title: "Board",
  placement: "side-panel",
});

async function publish(next: SessionPluginViews) {
  await act(async () => {
    state.current = next;
    for (const listener of state.listeners) listener();
  });
}

const frames = () => [...container.querySelectorAll("iframe")];

let container: HTMLDivElement;
let root: Root;

// Transform the lazy body once up front, so mounting it settles inside one act().
beforeAll(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  await import("./PluginViewSidePanel");
});

beforeEach(async () => {
  state.current = { session: null, views: null };
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root.render(
      <PanelHostContext value={host}>
        <RegisteredSidePanel id="plugin-view" surface={surface} />
      </PanelHostContext>,
    );
  });
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe("a registered plugin view tab", () => {
  it("mounts only what the current session offers and tears the frame down when that ends", async () => {
    const sessionA = {} as NonNullable<SessionPluginViews["session"]>;
    await publish({
      session: sessionA,
      views: { _tag: "available", views: [view(1)], problems: [] },
    });
    expect(frames()).toHaveLength(1);
    const [first] = frames();
    expect(first!.getAttribute("sandbox")).toBe("allow-scripts");
    expect(first!.getAttribute("allow")).toBe("");
    expect(first!.srcdoc).toContain("'sha256-hash-1'");

    // A re-enable or server restart can arrive as one snapshot: the new generation replaces
    // the old frame instead of reusing it.
    await publish({
      session: sessionA,
      views: { _tag: "available", views: [view(2)], problems: [] },
    });
    expect(frames()).toHaveLength(1);
    expect(frames()[0]).not.toBe(first);
    expect(frames()[0]!.srcdoc).toContain("'sha256-hash-2'");
    expect(frames()[0]!.srcdoc).not.toContain("'sha256-hash-1'");

    // Disable or remove: the snapshot no longer lists the view.
    await publish({ session: sessionA, views: { _tag: "available", views: [], problems: [] } });
    expect(frames()).toHaveLength(0);
    expect(container.textContent).toContain("Board is not available");

    // A new session has no authority until it sends its own snapshot.
    await publish({ session: {} as NonNullable<SessionPluginViews["session"]>, views: null });
    expect(frames()).toHaveLength(0);
    expect(container.textContent).toContain("Waiting for the environment.");

    // A server without views never shows one.
    await publish({ session: sessionA, views: { _tag: "unsupported" } });
    expect(frames()).toHaveLength(0);
    expect(container.textContent).toContain("Plugin views are unavailable");
  });
});
