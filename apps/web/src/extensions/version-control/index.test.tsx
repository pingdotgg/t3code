import { act, createContext, useContext, useEffect, useState } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import type { ViewRecord } from "@t3tools/extension-sdk/contracts";
import { createExtensionHost } from "@t3tools/extension-sdk/host";
import { ExtensionSurface, type SurfaceRenderer } from "@t3tools/extension-sdk/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { PullRequestDetailPanel } from "../../components/pullRequest/PullRequestDetailPanel";
import { PullRequestDetailGhost } from "../../components/pullRequest/PullRequestGhosts";
import { PullRequestsUnavailableState } from "../../components/pullRequest/PullRequestsUnavailableState";
import { ThreadPullRequestsPanel } from "../../components/pullRequest/ThreadPullRequestsPanel";
import { createVersionControlExtension, type VersionControlBindings } from "./index";

const lifecycle = vi.hoisted(() => ({ mounts: 0, unmounts: 0 }));

vi.mock("../../components/pullRequest/PullRequestDetailPanel", () => ({
  PullRequestDetailPanel: function DetailProbe(props: {
    environmentId: string;
    reference: { repository: string; number: number };
    context?: string;
    onActed?: () => void;
  }) {
    const [draft, setDraft] = useState("");
    useEffect(() => {
      lifecycle.mounts++;
      return () => {
        lifecycle.unmounts++;
      };
    }, []);
    return (
      <section>
        <span>{`${props.environmentId}:${props.reference.repository}#${props.reference.number}:${props.context}`}</span>
        <input value={draft} onChange={(event) => setDraft(event.target.value)} />
        <button onClick={props.onActed}>Acted</button>
      </section>
    );
  },
}));
vi.mock("../../components/pullRequest/PullRequestGhosts", () => ({
  PullRequestDetailGhost: () => <span>Loading pull request</span>,
}));
vi.mock("../../components/pullRequest/PullRequestsUnavailableState", () => ({
  PullRequestsUnavailableState: ({ title, error }: { title: string; error: string }) => (
    <span>{`${title}: ${error}`}</span>
  ),
}));

const BindingsContext = createContext<VersionControlBindings>({ status: "loading" });
const useBindings = () => useContext(BindingsContext);
const threadRef = {
  environmentId: EnvironmentId.make("environment-a"),
  threadId: ThreadId.make("thread-a"),
};
const detail = {
  environmentId: threadRef.environmentId,
  threadRef,
  reference: { projectId: ProjectId.make("project-a"), repository: "owner/repo", number: 42 },
  context: "thread" as const,
  composerDraftTarget: threadRef,
  shortcutsEnabled: false,
  getShortcutContext: () => ({
    terminalFocus: false,
    terminalOpen: false,
    previewFocus: false,
    previewOpen: false,
    isWeb: true,
    isDesktop: false,
  }),
};
const readyBindings: VersionControlBindings = { status: "ready", detail };
const record: ViewRecord = {
  version: 1,
  surfaceId: "t3.version-control/view",
  placement: "side-panel",
  stateVersion: 1,
  restoreState: null,
  fallback: "Version Control unavailable",
  context: {
    client: "web",
    resource: {
      namespace: "t3.version-control",
      id: "owner/repo#42",
      environmentId: "environment-a",
      projectId: "project-a",
      threadId: "thread-a",
    },
  },
};

function BuiltIn({ bindings }: { bindings: VersionControlBindings }) {
  if (bindings.status === "list") return <ThreadPullRequestsPanel threadRef={bindings.threadRef} />;
  if (bindings.status === "loading") return <PullRequestDetailGhost />;
  if (bindings.status === "unavailable") {
    return (
      <PullRequestsUnavailableState
        title="Pull requests unavailable"
        error="Update this environment's T3 Code server to browse pull requests."
      />
    );
  }
  return (
    <PullRequestDetailPanel
      key={`${bindings.detail.environmentId}:${bindings.detail.reference.projectId}:${bindings.detail.reference.host ?? ""}:${bindings.detail.reference.repository}#${bindings.detail.reference.number}`}
      {...bindings.detail}
    />
  );
}

const trees: ReactTestRenderer[] = [];
const hosts: ReturnType<typeof createExtensionHost<SurfaceRenderer>>[] = [];

async function setup(bindings: VersionControlBindings, client = "web") {
  const host = createExtensionHost<SurfaceRenderer>({ authorize: () => false });
  hosts.push(host);
  host.register(createVersionControlExtension(useBindings));
  const viewId = await host.open({ ...record, context: { ...record.context, client } });
  const render = (next: VersionControlBindings) => (
    <BindingsContext value={next}>
      <ExtensionSurface host={host} viewId={viewId} />
    </BindingsContext>
  );
  let tree!: ReactTestRenderer;
  await act(async () => {
    tree = create(render(bindings));
  });
  trees.push(tree);
  return {
    host,
    viewId,
    tree,
    update: (next: VersionControlBindings) => act(async () => tree.update(render(next))),
  };
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  lifecycle.mounts = 0;
  lifecycle.unmounts = 0;
});
afterEach(async () => {
  await act(async () => {
    for (const tree of trees.splice(0)) tree.unmount();
    for (const host of hosts.splice(0)) host.dispose();
  });
  vi.unstubAllGlobals();
});

describe("registered native Version Control composition", () => {
  it.each(["web", "desktop"])(
    "matches built-in gates, props and retargeting on %s",
    async (client) => {
      const candidate = await setup({ status: "loading" }, client);
      let baseline!: ReactTestRenderer;
      await act(async () => {
        baseline = create(<BuiltIn bindings={{ status: "loading" }} />);
      });
      trees.push(baseline);
      const onActed = vi.fn();
      const fixtures: VersionControlBindings[] = [
        { status: "loading" },
        { status: "unavailable" },
        { status: "ready", detail: { ...detail, onActed } },
        { status: "ready", detail: { ...detail, context: "page", refreshToken: 2, onActed } },
        { status: "ready", detail: { ...detail, reference: { ...detail.reference, number: 43 } } },
      ];
      for (const bindings of fixtures) {
        await candidate.update(bindings);
        await act(async () => baseline.update(<BuiltIn bindings={bindings} />));
        expect(JSON.parse(JSON.stringify(candidate.tree.toJSON()))).toMatchObject({
          children: [JSON.parse(JSON.stringify(baseline.toJSON()))],
        });
        if (bindings.status === "ready") {
          expect(candidate.tree.root.findByType(PullRequestDetailPanel).props).toEqual(
            baseline.root.findByType(PullRequestDetailPanel).props,
          );
          if (bindings.detail.onActed) {
            await act(async () => {
              candidate.tree.root.findByType("button").props.onClick();
              baseline.root.findByType("button").props.onClick();
            });
          }
        }
      }
      expect(lifecycle.mounts).toBe(4);
      expect(lifecycle.unmounts).toBe(2);
      expect(onActed).toHaveBeenCalledTimes(4);
    },
  );

  it("retains local draft across hide/show and binding refresh, resets on PR switch", async () => {
    const candidate = await setup({ status: "ready", detail });
    const renderer = candidate.host.renderer(candidate.viewId);
    await act(async () =>
      candidate.tree.root.findByType("input").props.onChange({ target: { value: "review draft" } }),
    );
    await act(async () => candidate.host.hide(candidate.viewId));
    expect(candidate.tree.root.findByType("input").props.value).toBe("review draft");
    await act(async () => candidate.host.show(candidate.viewId));
    await candidate.update({ status: "ready", detail: { ...detail, refreshToken: 1 } });
    expect(candidate.host.renderer(candidate.viewId)).toBe(renderer);
    expect(candidate.tree.root.findByType("input").props.value).toBe("review draft");
    expect(lifecycle.mounts).toBe(1);
    await candidate.update({
      status: "ready",
      detail: { ...detail, reference: { ...detail.reference, number: 43 } },
    });
    expect(candidate.tree.root.findByType("input").props.value).toBe("");
    expect(lifecycle.unmounts).toBe(1);
  });

  it("isolates viewers and resets on environment generation without invoking domain services", async () => {
    const first = await setup({ status: "ready", detail });
    const second = await setup({ status: "ready", detail });
    await act(async () =>
      first.tree.root.findByType("input").props.onChange({ target: { value: "private draft" } }),
    );
    await act(async () =>
      first.host.updateContext(first.viewId, {
        ...record.context,
        resource: { ...record.context.resource, environmentId: "environment-b" },
      }),
    );
    await first.update({
      status: "ready",
      detail: { ...detail, environmentId: EnvironmentId.make("environment-b") },
    });
    expect(first.tree.root.findByType("input").props.value).toBe("");
    expect(first.tree.root.findByType("span").children.join("")).toContain("environment-b:");
    await act(async () => first.host.close(first.viewId));
    expect(second.host.getSnapshot(second.viewId)?.status).toBe("ready");
    expect(second.tree.root.findByType("input").props.value).toBe("");
  });

  it("accepts host-owned null restore and contains disabled/unsupported/invalid viewers", async () => {
    const candidate = await setup({ status: "ready", detail });
    const invalid = await candidate.host.open({
      ...record,
      restoreState: { draft: "not SDK owned" },
    });
    expect(candidate.host.getSnapshot(invalid)?.status).toBe("unavailable");
    const mobile = await candidate.host.open({
      ...record,
      context: { ...record.context, client: "mobile" },
    });
    expect(candidate.host.getSnapshot(mobile)?.status).toBe("unavailable");
    await act(async () => candidate.host.disable("t3.version-control"));
    expect(candidate.host.getSnapshot(candidate.viewId)?.status).toBe("unavailable");
    expect(lifecycle.unmounts).toBe(1);
    candidate.host.enable("t3.version-control");
    await act(async () => candidate.host.show(candidate.viewId));
    expect(candidate.host.getSnapshot(candidate.viewId)?.status).toBe("ready");
  });

  it("does not call the bindings hook during registration or activation", async () => {
    const hook = vi.fn(useBindings);
    const host = createExtensionHost<SurfaceRenderer>({ authorize: () => false });
    hosts.push(host);
    host.register(createVersionControlExtension(hook));
    await host.open(record);
    expect(hook).not.toHaveBeenCalled();
  });

  it("restores the scoped host record without creating domain resources", async () => {
    const candidate = await setup({ status: "ready", detail });
    const [saved] = candidate.host.records();
    expect(saved).toEqual(record);
    await act(async () => candidate.host.close(candidate.viewId));
    const restored = await candidate.host.restore(saved!);
    await act(async () =>
      candidate.tree.update(
        <BindingsContext value={readyBindings}>
          <ExtensionSurface host={candidate.host} viewId={restored} />
        </BindingsContext>,
      ),
    );
    expect(candidate.host.getSnapshot(restored)?.status).toBe("ready");
    expect(candidate.tree.root.findByType(PullRequestDetailPanel).props).toEqual(detail);
  });

  it("contains binding failures in the real SDK React boundary", async () => {
    const candidate = await setup({ status: "ready", detail });
    candidate.host.register(createVersionControlExtensionForFailure());
    const failed = await candidate.host.open({ ...record, surfaceId: "test.failure/view" });
    let failedTree!: ReactTestRenderer;
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await act(async () => {
        failedTree = create(<ExtensionSurface host={candidate.host} viewId={failed} />);
      });
      trees.push(failedTree);
      expect(candidate.host.getSnapshot(failed)?.status).toBe("error");
      expect(candidate.host.getSnapshot(candidate.viewId)?.status).toBe("ready");
    } finally {
      consoleError.mockRestore();
    }
  });

  it("drains mounted viewers after 100 open/hide/show/close cycles", async () => {
    const candidate = await setup({ status: "ready", detail });
    await act(async () => candidate.host.close(candidate.viewId));
    for (let cycle = 0; cycle < 100; cycle++) {
      const viewId = await candidate.host.open(record);
      await act(async () =>
        candidate.tree.update(
          <BindingsContext value={readyBindings}>
            <ExtensionSurface host={candidate.host} viewId={viewId} />
          </BindingsContext>,
        ),
      );
      await act(async () => candidate.host.hide(viewId));
      await act(async () => candidate.host.show(viewId));
      await act(async () => candidate.host.close(viewId));
    }
    expect(candidate.host.records()).toEqual([]);
    expect(lifecycle.mounts).toBe(101);
    expect(lifecycle.unmounts).toBe(101);
  });
});

function createVersionControlExtensionForFailure() {
  const extension = createVersionControlExtension(() => {
    throw new Error("Host binding unavailable");
  });
  return {
    ...extension,
    manifest: {
      ...extension.manifest,
      id: "test.failure",
      surfaces: extension.manifest.surfaces.map((surface) => ({
        ...surface,
        id: "test.failure/view",
      })),
    },
    surfaces: extension.surfaces.map((surface) => ({ ...surface, id: "test.failure/view" })),
  };
}
