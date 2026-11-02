import { RegistryContext } from "@effect/atom-react";
import {
  EnvironmentId,
  ThreadId,
  type OrchestrationV2ThreadFamily,
  type OrchestrationV2ThreadShell,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { formatThreadLink, type ThreadLink } from "@t3tools/shared/threadLinks";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

const ENV = EnvironmentId.make("environment-links");
const row = (id: string, title: string) =>
  ({ id: ThreadId.make(id), title }) as OrchestrationV2ThreadShell;
const PARENT = row("parent", "Ship the release");
const CHILD = row("thread:delegated-task:01JCHILD", "Check the changelog");

// The shell omits idle subagents (`omitIdleSubagents`); the family read still returns them.
const server = await vi.hoisted(async () => {
  const { Atom, AsyncResult } = await import("effect/reactivity");
  const key = (environmentId: string, threadId: string) =>
    JSON.stringify([environmentId, threadId]);
  const shellRows = Atom.make<ReadonlyArray<OrchestrationV2ThreadShell>>([]).pipe(Atom.keepAlive);
  const mounted = Atom.make<ReadonlyMap<string, ReadonlyArray<OrchestrationV2ThreadShell>>>(
    new Map(),
  ).pipe(Atom.keepAlive);
  const merged = Atom.make((get) => {
    const rows = new Map<string, OrchestrationV2ThreadShell>(
      get(shellRows).map((thread) => [thread.id, thread]),
    );
    for (const threads of get(mounted).values()) {
      for (const thread of threads) if (!rows.has(thread.id)) rows.set(thread.id, thread);
    }
    return rows;
  });
  const families = new Map<string, OrchestrationV2ThreadFamily | "pending" | "failed">();
  return { key, shellRows, mounted, merged, families, AsyncResult, Atom };
});

vi.mock("./threads", () => {
  const { Atom, AsyncResult, key, merged, mounted, families } = server;
  type Registry = import("effect/reactivity").AtomRegistry.AtomRegistry;
  const readOf = (environmentId: string, threadId: string) =>
    families.get(key(environmentId, threadId)) ?? null;
  const familyFor = (environmentId: string, threadId: string) => {
    const read = readOf(environmentId, threadId);
    return typeof read === "string" ? null : read;
  };
  const addRows = (
    registry: Registry,
    mountKey: string,
    threads: ReadonlyArray<OrchestrationV2ThreadShell>,
  ) => {
    registry.set(mounted, new Map(registry.get(mounted)).set(mountKey, threads));
    return () => {
      const next = new Map(registry.get(mounted));
      next.delete(mountKey);
      registry.set(mounted, next);
    };
  };
  const threadShellAtom = Atom.family((refKey: string) =>
    Atom.make((get) => {
      const [environmentId, threadId] = JSON.parse(refKey) as [string, string];
      const thread = get(merged).get(threadId);
      return thread ? { ...thread, environmentId } : null;
    }),
  );
  return {
    environmentThreadShells: {
      threadShellAtom: (ref: ScopedThreadRef) =>
        threadShellAtom(key(ref.environmentId, ref.threadId)),
      threadRefsAtom: Atom.make([]),
    },
    environmentThreadDetails: {},
    threadFamilies: {
      familyAtom: (environmentId: string, threadId: string) => {
        const read = readOf(environmentId, threadId);
        return Atom.make(
          read === null || read === "failed"
            ? AsyncResult.fail(new Error("not a known thread"))
            : read === "pending"
              ? AsyncResult.initial(true)
              : AsyncResult.success(read),
        );
      },
      mount: (registry: Registry, environmentId: string, threadId: string) =>
        addRows(
          registry,
          `family:${key(environmentId, threadId)}`,
          familyFor(environmentId, threadId)?.threads ?? [],
        ),
      mountRows: (
        registry: Registry,
        _environmentId: string,
        mountKey: string,
        rows: import("effect/reactivity").Atom.Atom<ReadonlyArray<OrchestrationV2ThreadFamily>>,
      ) =>
        addRows(
          registry,
          mountKey,
          registry.get(rows).flatMap((family) => family.threads),
        ),
      refresh: () => {},
    },
  };
});
vi.mock("./projects", () => ({ environmentProjects: {} }));
vi.mock("./server", () => ({ environmentServerConfigsAtom: {}, serverEnvironment: {} }));
vi.mock("./assets", () => ({ projectFaviconUrlAtom: () => null }));
vi.mock("../native/ProjectChipIconImages", () => ({
  projectGlyphImageAtom: () => null,
  projectGlyphKey: () => "",
}));
vi.mock("../lib/projectIcon", () => ({ resolveProjectChipIcon: () => null }));
vi.mock("../lib/enrichedLinkPresentation", () => ({ threadChipTargets: () => [] }));

import { appAtomRegistry } from "./atom-registry";
import { resolveThreadLink, useLiveThreadLinkLabels } from "./entities";

function setup() {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const family: OrchestrationV2ThreadFamily = { snapshotSequence: 3, threads: [PARENT, CHILD] };
  server.families.clear();
  server.families.set(server.key(ENV, PARENT.id), family);
  server.families.set(server.key(ENV, CHILD.id), family);
  appAtomRegistry.set(server.shellRows, [PARENT]);
  appAtomRegistry.set(server.mounted, new Map());
  const container = document.createElement("div");
  const root = createRoot(container);
  function Probe({ markdown }: { readonly markdown: string }) {
    return useLiveThreadLinkLabels(markdown, ENV);
  }
  const wrap = (node: ReactNode) => (
    <RegistryContext.Provider value={appAtomRegistry}>{node}</RegistryContext.Provider>
  );
  return {
    rendered: () => container.textContent,
    render(markdown: string) {
      act(() => root.render(wrap(<Probe markdown={markdown} />)));
    },
    [Symbol.dispose]() {
      act(() => root.unmount());
    },
  };
}

const childLink: ThreadLink = { environmentId: ENV, threadId: CHILD.id };
const parentReply = `Child: ${formatThreadLink(childLink)}`;

it("labels a link to an idle subagent the shell omitted with its title", () => {
  using harness = setup();
  harness.render(parentReply);

  expect(harness.rendered()).toBe(`Child: ${formatThreadLink(childLink, CHILD.title)}`);
});

it("opens a link to an idle subagent the shell omitted", () => {
  using harness = setup();
  harness.render(parentReply);

  expect(resolveThreadLink(appAtomRegistry.get.bind(appAtomRegistry), childLink, ENV)).toEqual(
    childLink,
  );
});

it("keeps a link's title when the shell drops a subagent it already rendered", () => {
  using harness = setup();
  act(() => appAtomRegistry.set(server.shellRows, [PARENT, CHILD]));
  harness.render(parentReply);
  act(() => appAtomRegistry.set(server.shellRows, [PARENT]));

  expect(harness.rendered()).toBe(`Child: ${formatThreadLink(childLink, CHILD.title)}`);
});

it("labels a link to a thread its settled family lacks as gone", () => {
  using harness = setup();
  server.families.set(server.key(ENV, CHILD.id), { snapshotSequence: 3, threads: [PARENT] });
  harness.render(parentReply);

  expect(harness.rendered()).toBe("Child: Thread no longer available");
});

it.each(["pending", "failed"] as const)(
  "titles an escaped link by its known decoded thread while the written id's read is %s",
  (read) => {
    using harness = setup();
    act(() => appAtomRegistry.set(server.shellRows, [PARENT, CHILD]));
    const escaped = ThreadId.make(encodeURIComponent(CHILD.id));
    server.families.set(server.key(ENV, escaped), read);
    harness.render(`Child: ${formatThreadLink({ environmentId: ENV, threadId: escaped })}`);

    expect(harness.rendered()).toBe(`Child: ${formatThreadLink(childLink, CHILD.title)}`);
  },
);

it.each(["pending", "failed"] as const)(
  "labels a link neutrally while its family read is %s, not as gone",
  (read) => {
    using harness = setup();
    server.families.set(server.key(ENV, CHILD.id), read);
    harness.render(`${parentReply} and ${formatThreadLink(childLink, "Changelog")}`);

    expect(harness.rendered()).toBe(
      `Child: ${formatThreadLink(childLink, "Thread")} and ${formatThreadLink(childLink, "Changelog")}`,
    );
  },
);
