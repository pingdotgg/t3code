import { PartialThreadLinkMetadataError } from "@t3tools/client-runtime/state/orchestration";
import { EnvironmentId, ProjectId, ThreadId, type ScopedThreadRef } from "@t3tools/contracts";
import { parseThreadLinkHref } from "@t3tools/shared/threadLinks";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

type MockShell = { title: string; projectId: ProjectId; updatedAt?: number };
type MockMetadataResult = AsyncResult.AsyncResult<
  Record<string, { title: string; projectId: ProjectId | null }>,
  string | PartialThreadLinkMetadataError
>;

const state = vi.hoisted(() => ({
  registry: null as AtomRegistry.AtomRegistry | null,
  lastAtom: null as Atom.Atom<unknown> | null,
  shellAtoms: new Map<string, Atom.Writable<MockShell | null, MockShell | null>>(),
  shellReads: 0,
  threadRefsAtom: null as Atom.Writable<
    ReadonlyArray<ScopedThreadRef>,
    ReadonlyArray<ScopedThreadRef>
  > | null,
  metadataCalls: [] as Array<{
    readonly environmentId: EnvironmentId;
    readonly threadIds: ReadonlyArray<ThreadId>;
  }>,
  metadataAtoms: new Map<string, Atom.Writable<MockMetadataResult, MockMetadataResult>>(),
  projects: new Map<string, { workspaceRoot: string; faviconPath: string | null }>(),
}));

function metadataKey(environmentId: EnvironmentId, threadIds: ReadonlyArray<ThreadId>) {
  return JSON.stringify([environmentId, threadIds]);
}

function getOrCreateShellAtom(key: string) {
  let atom = state.shellAtoms.get(key);
  if (atom === undefined) {
    atom = Atom.make<MockShell | null>(null).pipe(Atom.keepAlive);
    state.shellAtoms.set(key, atom);
  }
  return atom;
}

function getOrCreateMetadataAtom(environmentId: EnvironmentId, threadIds: ReadonlyArray<ThreadId>) {
  const key = metadataKey(environmentId, threadIds);
  let atom = state.metadataAtoms.get(key);
  if (atom === undefined) {
    atom = Atom.make<MockMetadataResult>(AsyncResult.initial()).pipe(Atom.keepAlive);
    state.metadataAtoms.set(key, atom);
  }
  return atom;
}

vi.mock(import("@effect/atom-react"), () => ({
  useAtomValue: ((atom: Atom.Atom<unknown>) => {
    state.lastAtom = atom;
    return state.registry!.get(atom);
  }) as never,
}));
vi.mock(
  import("gt-react-native"),
  () =>
    ({
      msg: (text: string) => text,
      useGT: () => (text: string) => text,
      useMessages: () => (text: string) => text,
    }) as never,
);
vi.mock(import("./threads"), () => ({
  environmentThreadDetails: {} as never,
  environmentThreadShells: {
    threadShellAtom: (ref: ScopedThreadRef) => {
      state.shellReads++;
      return getOrCreateShellAtom(`${ref.environmentId}/${ref.threadId}`);
    },
    quietThreadShellAtom: (ref: ScopedThreadRef) => {
      state.shellReads++;
      return getOrCreateShellAtom(`${ref.environmentId}/${ref.threadId}`);
    },
    get threadRefsAtom() {
      return state.threadRefsAtom!;
    },
  } as never,
}));
vi.mock(import("./orchestration"), () => ({
  orchestrationEnvironment: {
    threadLinkMetadata: (target: {
      readonly environmentId: EnvironmentId;
      readonly input: { readonly threadIds: ReadonlyArray<ThreadId> };
    }) => {
      state.metadataCalls.push({
        environmentId: target.environmentId,
        threadIds: target.input.threadIds,
      });
      return getOrCreateMetadataAtom(target.environmentId, target.input.threadIds);
    },
  } as never,
}));
vi.mock(import("./atom-registry"), () => ({ appAtomRegistry: {} as never }));
vi.mock(import("./projects"), async () => {
  const { Atom } = await import("effect/reactivity");
  return {
    environmentProjects: {
      projectAtom: (ref: { environmentId: EnvironmentId; projectId: ProjectId }) =>
        Atom.make(state.projects.get(`${ref.environmentId}/${ref.projectId}`) ?? null),
    } as never,
  };
});
vi.mock(import("./server"), async () => {
  const { Atom } = await import("effect/reactivity");
  return {
    environmentServerConfigsAtom: {} as never,
    serverEnvironment: {
      configValueAtom: () => Atom.make(null),
    } as never,
  };
});
vi.mock(import("./assets"), async () => {
  const { Atom } = await import("effect/reactivity");
  return {
    projectFaviconUrlAtom: ((target: { cwd: string }) =>
      Atom.make(`https://favicon.test/${target.cwd}`)) as never,
  };
});
vi.mock(import("../native/ProjectChipIconImages"), async () => {
  const { AsyncResult, Atom } = await import("effect/reactivity");
  return {
    projectGlyphImageAtom: (() => Atom.make(AsyncResult.initial())) as never,
    projectGlyphKey: (() => "") as never,
  };
});

import {
  resolveThreadLink,
  resolveThreadLinkTarget,
  useMessageThreadLinks,
  useThreadChipIcons,
} from "./entities";

function setup() {
  const registry = AtomRegistry.make();
  state.registry = registry;
  state.lastAtom = null;
  state.shellAtoms = new Map();
  state.shellReads = 0;
  state.threadRefsAtom = Atom.make<ReadonlyArray<ScopedThreadRef>>([
    { environmentId: EnvironmentId.make("remote"), threadId: ThreadId.make("older-thread") },
  ]).pipe(Atom.keepAlive);
  state.metadataCalls = [];
  state.metadataAtoms = new Map();
  state.projects = new Map();
  const setShell = (environmentId: EnvironmentId, threadId: ThreadId, shell: MockShell | null) => {
    registry.set(getOrCreateShellAtom(`${environmentId}/${threadId}`), shell);
  };
  const setMetadata = (
    environmentId: EnvironmentId,
    threadIds: ReadonlyArray<ThreadId>,
    result: MockMetadataResult,
  ) => {
    registry.set(getOrCreateMetadataAtom(environmentId, threadIds), result);
  };
  return { registry, setShell, setMetadata };
}

it("uses confirmed matches instead of provisional titles when resolving legacy and percent-encoded links", () => {
  const { registry, setMetadata } = setup();
  using _registry = { [Symbol.dispose]: () => registry.dispose() };
  const localEnv = EnvironmentId.make("local");
  const remoteEnv = EnvironmentId.make("remote");
  const olderId = ThreadId.make("older-thread");
  const otherId = ThreadId.make("other-archived");
  const local: ScopedThreadRef = { environmentId: localEnv, threadId: olderId };
  const remote: ScopedThreadRef = { environmentId: remoteEnv, threadId: olderId };
  const link = { environmentId: null, threadId: olderId };
  const resolveSingle = () => resolveThreadLink(registry.get.bind(registry), link, localEnv);

  expect(resolveSingle()).toEqual(remote);
  setMetadata(localEnv, [olderId], AsyncResult.failure(Cause.fail("offline")));
  expect(resolveSingle()).toEqual(remote);
  expect(resolveThreadLink(registry.get.bind(registry), local, remoteEnv)).toEqual(local);
  setMetadata(
    localEnv,
    [olderId],
    AsyncResult.success({
      [olderId]: { title: "Thread", projectId: ProjectId.make("project") },
    }),
  );
  expect(resolveSingle()).toEqual(local);
  setMetadata(localEnv, [olderId], AsyncResult.success({}));
  expect(resolveSingle()).toEqual(remote);

  // With two archived v1 links in the same message, the single-ID query stays cold/empty while
  // the message's batched query confirms local/older-thread: display, icon, and tap all match local.
  const localProject = ProjectId.make("proj-local");
  state.projects.set(`${localEnv}/${localProject}`, {
    workspaceRoot: "local-repo",
    faviconPath: "icon.png",
  });
  const sourceMarkdown = `[a](t3-thread://v1/${olderId}) [b](t3-thread://v1/${otherId})`;
  setMetadata(
    localEnv,
    [olderId, otherId],
    AsyncResult.success({
      [olderId]: { title: "Local archived", projectId: localProject },
      [otherId]: { title: "Other local", projectId: localProject },
    }),
  );
  const messageLinks = useMessageThreadLinks(sourceMarkdown, localEnv);
  expect(messageLinks.markdown).toBe(
    `[Local archived](t3-thread://v1/${olderId}) [Other local](t3-thread://v1/${otherId})`,
  );
  expect(resolveThreadLink(registry.get.bind(registry), link, localEnv, messageLinks)).toEqual(
    local,
  );
  expect(
    useThreadChipIcons(localEnv, messageLinks.markdown, {
      sourceRefKeys: messageLinks.refKeys,
    }).get(`t3-thread://v1/${olderId}`),
  ).toBe("https://favicon.test/local-repo");

  // Percent-encoded archived links resolve to the decoded ID from the message's batched metadata.
  const encodedId = ThreadId.make("arch%201");
  const decodedId = ThreadId.make("arch 1");
  const encodedMarkdown = `[e](t3-thread://v2/${localEnv}/${encodedId}) [o](t3-thread://v2/${localEnv}/${otherId})`;
  setMetadata(
    localEnv,
    [decodedId, encodedId, otherId],
    AsyncResult.success({
      [decodedId]: { title: "Decoded Archived", projectId: localProject },
    }),
  );
  const encodedLinks = useMessageThreadLinks(encodedMarkdown, localEnv);
  expect(
    resolveThreadLink(
      registry.get.bind(registry),
      { environmentId: localEnv, threadId: encodedId },
      localEnv,
      encodedLinks,
    ),
  ).toEqual({ environmentId: localEnv, threadId: decodedId });

  // A titled Markdown link not indexed by threadLinkRefs must fall back to per-link lookup
  // instead of trusting the message index and opening the raw percent-encoded ID.
  const slashEncodedId = ThreadId.make("a%2Fb");
  const slashDecodedId = ThreadId.make("a/b");
  registry.set(getOrCreateShellAtom(`${localEnv}/${slashDecodedId}`), {
    title: "Live Slash Thread",
    projectId: localProject,
  });
  const titledMarkdown = `[ok](t3-thread://v2/${localEnv}/${otherId}) [other](t3-thread://v2/${localEnv}/${slashEncodedId} "Details")`;
  const titledLinks = useMessageThreadLinks(titledMarkdown, localEnv);
  const slashLink = { environmentId: localEnv, threadId: slashEncodedId };
  expect(titledLinks.resolve(slashLink, registry.get.bind(registry))).toEqual({
    environmentId: localEnv,
    threadId: slashDecodedId,
  });
  expect(resolveThreadLink(registry.get.bind(registry), slashLink, localEnv, titledLinks)).toEqual({
    environmentId: localEnv,
    threadId: slashDecodedId,
  });

  // Bracketed link labels match threadChipTargets even when threadLinkRefs skips them;
  // chip icons must still request metadata for those uncovered targets.
  const bracketedId = ThreadId.make("bracketed-archived");
  setMetadata(
    localEnv,
    [bracketedId],
    AsyncResult.success({
      [bracketedId]: { title: "Bracketed Archived", projectId: localProject },
    }),
  );
  const bracketedMarkdown = `[outer [inner]](t3-thread://v2/${localEnv}/${bracketedId})`;
  const bracketedLinks = useMessageThreadLinks(bracketedMarkdown, localEnv);
  expect(bracketedLinks.refKeys).toEqual([]);
  expect(
    useThreadChipIcons(localEnv, bracketedLinks.markdown, {
      sourceRefKeys: bracketedLinks.refKeys,
    }).get(`t3-thread://v2/${localEnv}/${bracketedId}`),
  ).toBe("https://favicon.test/local-repo");
});

it("batches missing thread link metadata per environment and keeps icon queries aligned after relabeling", () => {
  const { registry, setShell, setMetadata } = setup();
  using _registry = { [Symbol.dispose]: () => registry.dispose() };
  const envA = EnvironmentId.make("env-a");
  const envB = EnvironmentId.make("env-b");
  const projectA = ProjectId.make("proj-a");
  const inShell = ThreadId.make("in-shell");
  const arch1 = ThreadId.make("arch-1");
  const arch2 = ThreadId.make("arch-2");
  const deleted1 = ThreadId.make("deleted-1");
  const remote1 = ThreadId.make("remote-1");

  setShell(envA, inShell, { title: "In Shell", projectId: projectA });
  setMetadata(
    envB,
    [remote1],
    AsyncResult.success({
      [remote1]: { title: "Remote One", projectId: null },
    }),
  );
  state.projects.set(`${envA}/${projectA}`, { workspaceRoot: "repo-a", faviconPath: "icon.png" });

  const markdown = [
    "[s](t3-thread://v2/env-a/in-shell)",
    "[a](t3-thread://v2/env-a/arch-2)",
    "[b](t3-thread://v2/env-a/arch-1)",
    "[c](t3-thread://v2/env-a/arch-2)",
    "[d](t3-thread://v2/env-a/deleted-1)",
    "[r](t3-thread://v2/env-b/remote-1)",
  ].join(" ");

  // While env-a metadata is pending, titles use fallback and only ONE batched query per env is made.
  const pendingLinks = useMessageThreadLinks(markdown, envA);
  expect(pendingLinks.markdown).toContain("[In Shell](t3-thread://v2/env-a/in-shell)");
  expect(pendingLinks.markdown).toContain("[Thread](t3-thread://v2/env-a/arch-1)");
  expect(pendingLinks.markdown).toContain("[Remote One](t3-thread://v2/env-b/remote-1)");
  expect(state.metadataCalls).toEqual([
    { environmentId: envA, threadIds: [arch1, arch2, deleted1] },
    { environmentId: envB, threadIds: [remote1] },
  ]);

  // Chip icons issue the exact same sorted threadIds per environment.
  state.metadataCalls = [];
  const pendingIcons = useThreadChipIcons(envA, pendingLinks.markdown, {
    sourceRefKeys: pendingLinks.refKeys,
  });
  expect(pendingIcons.get("t3-thread://v2/env-a/in-shell")).toBe("https://favicon.test/repo-a");
  expect(pendingIcons.has("t3-thread://v2/env-a/arch-1")).toBe(false);
  expect(state.metadataCalls).toEqual([
    { environmentId: envA, threadIds: [arch1, arch2, deleted1] },
    { environmentId: envB, threadIds: [remote1] },
  ]);

  // Once the single batch resolves, deleted links drop to plain text and chip icons reuse the
  // exact same metadata key without issuing a shrunk query.
  setMetadata(
    envA,
    [arch1, arch2, deleted1],
    AsyncResult.success({
      [arch1]: { title: "Archived One", projectId: projectA },
      [arch2]: { title: "Archived Two", projectId: projectA },
    }),
  );
  const resolvedLinks = useMessageThreadLinks(markdown, envA);
  expect(resolvedLinks.markdown).toBe(
    [
      "[In Shell](t3-thread://v2/env-a/in-shell)",
      "[Archived Two](t3-thread://v2/env-a/arch-2)",
      "[Archived One](t3-thread://v2/env-a/arch-1)",
      "[Archived Two](t3-thread://v2/env-a/arch-2)",
      "d",
      "[Remote One](t3-thread://v2/env-b/remote-1)",
    ].join(" "),
  );

  state.metadataCalls = [];
  const resolvedIcons = useThreadChipIcons(envA, resolvedLinks.markdown, {
    sourceRefKeys: resolvedLinks.refKeys,
  });
  expect(resolvedIcons.get("t3-thread://v2/env-a/arch-1")).toBe("https://favicon.test/repo-a");
  expect(resolvedIcons.get("t3-thread://v2/env-a/arch-2")).toBe("https://favicon.test/repo-a");
  expect(state.metadataCalls).toEqual([
    { environmentId: envA, threadIds: [arch1, arch2, deleted1] },
    { environmentId: envB, threadIds: [remote1] },
  ]);
});

it("resolves 52 iOS context menus from one message lookup with zero extra shell or metadata reads", () => {
  const { registry, setMetadata } = setup();
  using _registry = { [Symbol.dispose]: () => registry.dispose() };
  const envA = EnvironmentId.make("env-a");
  const projectA = ProjectId.make("proj-a");
  const ids = Array.from({ length: 52 }, (_, index) =>
    ThreadId.make(`target-${String(index + 1).padStart(2, "0")}`),
  );
  const reply: Record<string, { title: string; projectId: ProjectId | null }> = {};
  for (const id of ids) {
    reply[id] = { title: `Title ${id}`, projectId: projectA };
  }
  setMetadata(envA, ids, AsyncResult.success(reply));
  const urls = ids.map((id) => `t3-thread://v2/${envA}/${id}`);
  const markdown = urls.map((url, index) => `[link-${index}](${url})`).join(" ");

  const messageLinks = useMessageThreadLinks(markdown, envA);
  expect(state.shellReads).toBe(52);
  expect(state.metadataCalls).toHaveLength(1);

  state.shellReads = 0;
  state.metadataCalls = [];
  for (const url of urls) {
    const link = parseThreadLinkHref(url)!;
    const resolved = messageLinks.resolve(link, registry.get.bind(registry));
    expect(resolved).toEqual({ environmentId: envA, threadId: link.threadId });
    expect(messageLinks.titleFor(resolved!)).toBe(`Title ${link.threadId}`);
  }
  expect(state.shellReads).toBe(0);
  expect(state.metadataCalls).toEqual([]);
});

it("keeps v1 local targets consistent across shell removal, avoids flicker for archived/deleted links, and clears icons on failure", () => {
  const { registry, setShell, setMetadata } = setup();
  using _registry = { [Symbol.dispose]: () => registry.dispose() };
  const localEnv = EnvironmentId.make("local");
  const remoteEnv = EnvironmentId.make("remote");
  const projectLocal = ProjectId.make("proj-local");
  const projectRemote = ProjectId.make("proj-remote");
  const olderId = ThreadId.make("older-thread");
  const streamedNewId = ThreadId.make("streamed-new");
  const overlapShellId = ThreadId.make("overlap-shell");
  const archId = ThreadId.make("arch-1");
  const deletedId = ThreadId.make("deleted-1");

  registry.set(state.threadRefsAtom!, [
    { environmentId: remoteEnv, threadId: olderId },
    { environmentId: remoteEnv, threadId: streamedNewId },
  ]);
  setShell(localEnv, olderId, { title: "Local Live", projectId: projectLocal, updatedAt: 1 });
  setShell(localEnv, overlapShellId, {
    title: "Overlap Initial",
    projectId: projectLocal,
    updatedAt: 1,
  });
  setShell(remoteEnv, olderId, { title: "Remote Same ID", projectId: projectRemote, updatedAt: 1 });
  setShell(remoteEnv, streamedNewId, {
    title: "Remote Streamed",
    projectId: projectRemote,
    updatedAt: 1,
  });
  setMetadata(
    localEnv,
    [archId, deletedId],
    AsyncResult.success({
      [archId]: { title: "Archived One", projectId: projectLocal },
    }),
  );
  state.projects.set(`${localEnv}/${projectLocal}`, {
    workspaceRoot: "local-repo",
    faviconPath: "icon.png",
  });
  state.projects.set(`${remoteEnv}/${projectRemote}`, {
    workspaceRoot: "remote-repo",
    faviconPath: "icon.png",
  });

  const markdown = [
    `[v1](t3-thread://v1/${olderId})`,
    `[a](t3-thread://v2/${localEnv}/${archId})`,
    `[del](t3-thread://v2/${localEnv}/${deletedId})`,
  ].join(" ");

  const initial = useMessageThreadLinks(markdown, localEnv);
  const titlesAtom = state.lastAtom!;
  const initialIcons = useThreadChipIcons(localEnv, initial.markdown, {
    sourceRefKeys: initial.refKeys,
  });
  const iconsAtom = state.lastAtom!;
  expect(initial.markdown).toBe(
    `[Local Live](t3-thread://v1/${olderId}) [Archived One](t3-thread://v2/${localEnv}/${archId}) del`,
  );
  expect(initialIcons.get(`t3-thread://v2/${localEnv}/${archId}`)).toBe(
    "https://favicon.test/local-repo",
  );

  let titleUpdates = 0;
  let iconUpdates = 0;
  const unsubTitles = registry.subscribe(titlesAtom, () => {
    titleUpdates++;
  });
  const unsubIcons = registry.subscribe(iconsAtom, () => {
    iconUpdates++;
  });
  try {
    // Irrelevant shell updates that leave title and projectId unchanged emit zero notifications.
    setShell(localEnv, olderId, { title: "Local Live", projectId: projectLocal, updatedAt: 2 });
    expect(titleUpdates).toBe(0);
    expect(iconUpdates).toBe(0);

    // Renaming updates titles once without disturbing icons.
    setShell(localEnv, olderId, { title: "Local Renamed", projectId: projectLocal, updatedAt: 3 });
    expect(titleUpdates).toBe(1);
    expect(iconUpdates).toBe(0);

    // Mount an overlapping key [olderId, overlapShellId] while olderId is still in the shell.
    const overlapMarkdown = `[v1](t3-thread://v1/${olderId}) [x](t3-thread://v2/${localEnv}/${overlapShellId})`;
    expect(useMessageThreadLinks(overlapMarkdown, localEnv).markdown).toBe(
      `[Local Renamed](t3-thread://v1/${olderId}) [Overlap Initial](t3-thread://v2/${localEnv}/${overlapShellId})`,
    );
    const overlapTitlesAtom = state.lastAtom!;
    const unsubOverlap = registry.subscribe(overlapTitlesAtom, () => {});
    try {
      // While the post-archive batch is Initial, olderId must stay local (not remote),
      // archived chips must not flicker, and confirmed-deleted links must stay plain text.
      setShell(localEnv, olderId, null);
      const pendingAfterArchive = useMessageThreadLinks(markdown, localEnv);
      const overlapPendingBeforeMiss = useMessageThreadLinks(overlapMarkdown, localEnv);
      expect(pendingAfterArchive.markdown).toBe(
        `[Local Renamed](t3-thread://v1/${olderId}) [Archived One](t3-thread://v2/${localEnv}/${archId}) del`,
      );
      const v1Link = { environmentId: null, threadId: olderId };
      expect(
        resolveThreadLink(registry.get.bind(registry), v1Link, localEnv, pendingAfterArchive),
      ).toEqual({ environmentId: localEnv, threadId: olderId });
      expect(pendingAfterArchive.resolve(v1Link, registry.get.bind(registry))).toEqual({
        environmentId: localEnv,
        threadId: olderId,
      });
      expect(
        resolveThreadLinkTarget(
          registry.get.bind(registry),
          v1Link,
          localEnv,
          overlapPendingBeforeMiss,
        ),
      ).toEqual({ ref: { environmentId: localEnv, threadId: olderId }, title: "Local Renamed" });
      expect(overlapPendingBeforeMiss.resolve(v1Link, registry.get.bind(registry))).toEqual({
        environmentId: localEnv,
        threadId: olderId,
      });
      const pendingIcons = useThreadChipIcons(localEnv, pendingAfterArchive.markdown, {
        sourceRefKeys: pendingAfterArchive.refKeys,
      });
      expect(pendingIcons.get(`t3-thread://v1/${olderId}`)).toBe("https://favicon.test/local-repo");
      expect(pendingIcons.get(`t3-thread://v2/${localEnv}/${archId}`)).toBe(
        "https://favicon.test/local-repo",
      );

      // If streaming adds another link before the post-archive lookup settles, the new key carries
      // olderId's confirmed local target forward while keeping the newly added ref unconfirmed.
      const streamedMarkdown = `${markdown} [new](t3-thread://v1/${streamedNewId})`;
      const streamedPending = useMessageThreadLinks(streamedMarkdown, localEnv);
      expect(streamedPending.markdown).toContain(`[Local Renamed](t3-thread://v1/${olderId})`);
      expect(streamedPending.markdown).toContain(`[Thread](t3-thread://v1/${streamedNewId})`);
      expect(
        resolveThreadLinkTarget(registry.get.bind(registry), v1Link, localEnv, streamedPending),
      ).toEqual({ ref: { environmentId: localEnv, threadId: olderId }, title: "Local Renamed" });
      expect(
        resolveThreadLinkTarget(
          registry.get.bind(registry),
          { environmentId: null, threadId: streamedNewId },
          localEnv,
          streamedPending,
        ),
      ).toEqual({
        ref: { environmentId: remoteEnv, threadId: streamedNewId },
        title: "Remote Streamed",
      });

      // A settled miss records a confirmed miss for olderId. An overlapping pending key keeps
      // displaying its previous title locally, while tapping either key resolves the remote match.
      const priorSuccess = AsyncResult.success({
        [archId]: { title: "Archived One", projectId: projectLocal },
      });
      setMetadata(localEnv, [archId, deletedId, olderId], priorSuccess);
      expect(
        useThreadChipIcons(localEnv, pendingAfterArchive.markdown, {
          sourceRefKeys: pendingAfterArchive.refKeys,
        }).get(`t3-thread://v2/${localEnv}/${archId}`),
      ).toBe("https://favicon.test/local-repo");
      expect(
        resolveThreadLinkTarget(registry.get.bind(registry), v1Link, localEnv, pendingAfterArchive),
      ).toEqual({ ref: { environmentId: remoteEnv, threadId: olderId }, title: "Remote Same ID" });
      expect(
        resolveThreadLinkTarget(
          registry.get.bind(registry),
          v1Link,
          localEnv,
          overlapPendingBeforeMiss,
        ),
      ).toEqual({ ref: { environmentId: remoteEnv, threadId: olderId }, title: "Remote Same ID" });
      expect(overlapPendingBeforeMiss.resolve(v1Link, registry.get.bind(registry))).toEqual({
        environmentId: remoteEnv,
        threadId: olderId,
      });

      // Re-evaluate overlapMarkdown (its [olderId] query is still Initial) by renaming overlapShellId.
      setShell(localEnv, overlapShellId, {
        title: "Overlap Renamed",
        projectId: projectLocal,
        updatedAt: 2,
      });
      const overlapAfterMiss = useMessageThreadLinks(overlapMarkdown, localEnv);
      expect(overlapAfterMiss.markdown).toBe(
        `[Local Renamed](t3-thread://v1/${olderId}) [Overlap Renamed](t3-thread://v2/${localEnv}/${overlapShellId})`,
      );
      expect(
        resolveThreadLinkTarget(registry.get.bind(registry), v1Link, localEnv, overlapAfterMiss),
      ).toEqual({ ref: { environmentId: remoteEnv, threadId: olderId }, title: "Remote Same ID" });
      expect(overlapAfterMiss.resolve(v1Link, registry.get.bind(registry))).toEqual({
        environmentId: remoteEnv,
        threadId: olderId,
      });
      const freshAfterMiss = useMessageThreadLinks(
        `[v1](t3-thread://v1/${olderId}) [c](t3-thread://v2/${localEnv}/fresh-c)`,
        localEnv,
      );
      expect(
        resolveThreadLinkTarget(registry.get.bind(registry), v1Link, localEnv, freshAfterMiss),
      ).toEqual({
        ref: { environmentId: remoteEnv, threadId: olderId },
        title: "Remote Same ID",
      });

      // A partial batch failure applies succeeded titles/icons (archId) and confirmed misses
      // (deletedId) while failed IDs (olderId) render the fallback title and keep any confirmed miss.
      setMetadata(
        localEnv,
        [archId, deletedId, olderId],
        AsyncResult.failure(
          Cause.fail(
            new PartialThreadLinkMetadataError({
              metadata: {
                [archId]: { title: "Archived One", projectId: projectLocal },
              },
              failedThreadIds: [olderId],
              cause: "chunk 2 failed",
            }),
          ),
        ),
      );
      const partialLinks = useMessageThreadLinks(markdown, localEnv);
      expect(partialLinks.markdown).toBe(
        `[Thread](t3-thread://v1/${olderId}) [Archived One](t3-thread://v2/${localEnv}/${archId}) del`,
      );
      expect(
        resolveThreadLinkTarget(registry.get.bind(registry), v1Link, localEnv, partialLinks),
      ).toEqual({
        ref: { environmentId: remoteEnv, threadId: olderId },
        title: "Remote Same ID",
      });
      const partialIcons = useThreadChipIcons(localEnv, partialLinks.markdown, {
        sourceRefKeys: partialLinks.refKeys,
      });
      expect(partialIcons.get(`t3-thread://v2/${localEnv}/${archId}`)).toBe(
        "https://favicon.test/local-repo",
      );
      expect(partialIcons.get(`t3-thread://v1/${olderId}`)).toBe(
        "https://favicon.test/remote-repo",
      );

      // A settled total Failure—even with previousSuccess—clears confirmed local status (letting
      // the surviving remote v1 match win on tap, copy, and icon) and clears stale archived icons.
      setMetadata(
        localEnv,
        [archId, deletedId, olderId],
        AsyncResult.failure(Cause.fail("offline"), {
          previousSuccess: Option.some(priorSuccess),
        }),
      );
      const failedLinks = useMessageThreadLinks(markdown, localEnv);
      expect(failedLinks.markdown).toBe(
        `[Thread](t3-thread://v1/${olderId}) [Thread](t3-thread://v2/${localEnv}/${archId}) [Thread](t3-thread://v2/${localEnv}/${deletedId})`,
      );
      expect(
        resolveThreadLinkTarget(registry.get.bind(registry), v1Link, localEnv, failedLinks),
      ).toEqual({
        ref: { environmentId: remoteEnv, threadId: olderId },
        title: "Remote Same ID",
      });
      expect(failedLinks.resolve(v1Link, registry.get.bind(registry))).toEqual({
        environmentId: remoteEnv,
        threadId: olderId,
      });
      expect(failedLinks.titleFor({ environmentId: localEnv, threadId: olderId })).toBeNull();
      // After a settled failure clears positive confirmation (archId) while keeping confirmed misses
      // (olderId), a new streaming key drops stale local titles and an overlapping pending key still
      // resolves taps and icons to the remote match even after an unrelated shell rename.
      const afterFailureStreamed = useMessageThreadLinks(
        `${markdown} [later](t3-thread://v2/${localEnv}/later-1)`,
        localEnv,
      );
      expect(
        afterFailureStreamed.titleFor({ environmentId: localEnv, threadId: archId }),
      ).toBeNull();
      expect(
        resolveThreadLinkTarget(
          registry.get.bind(registry),
          v1Link,
          localEnv,
          afterFailureStreamed,
        ),
      ).toEqual({
        ref: { environmentId: remoteEnv, threadId: olderId },
        title: "Remote Same ID",
      });
      setShell(localEnv, overlapShellId, {
        title: "Overlap After Failure",
        projectId: projectLocal,
        updatedAt: 3,
      });
      const overlapAfterFailure = useMessageThreadLinks(overlapMarkdown, localEnv);
      expect(overlapAfterFailure.markdown).toBe(
        `[Local Renamed](t3-thread://v1/${olderId}) [Overlap After Failure](t3-thread://v2/${localEnv}/${overlapShellId})`,
      );
      expect(
        resolveThreadLinkTarget(registry.get.bind(registry), v1Link, localEnv, overlapAfterFailure),
      ).toEqual({
        ref: { environmentId: remoteEnv, threadId: olderId },
        title: "Remote Same ID",
      });
      expect(overlapAfterFailure.resolve(v1Link, registry.get.bind(registry))).toEqual({
        environmentId: remoteEnv,
        threadId: olderId,
      });
      expect(
        useThreadChipIcons(localEnv, overlapAfterFailure.markdown, {
          sourceRefKeys: overlapAfterFailure.refKeys,
        }).get(`t3-thread://v1/${olderId}`),
      ).toBe("https://favicon.test/remote-repo");
      const failedIcons = useThreadChipIcons(localEnv, failedLinks.markdown, {
        sourceRefKeys: failedLinks.refKeys,
      });
      expect(failedIcons.get(`t3-thread://v1/${olderId}`)).toBe("https://favicon.test/remote-repo");
      expect(failedIcons.has(`t3-thread://v2/${localEnv}/${archId}`)).toBe(false);
    } finally {
      unsubOverlap();
    }
  } finally {
    unsubTitles();
    unsubIcons();
  }
});
