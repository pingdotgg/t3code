import { useAtomValue } from "@effect/atom-react";
import {
  EnvironmentId,
  ThreadId,
  type OrchestrationV2ThreadFamily,
  type OrchestrationV2ThreadShell,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, render } from "../../../test/render";
import { AppAtomRegistryProvider, appAtomRegistry } from "../../rpc/atomRegistry";
import { environmentShell } from "../../state/shell";
import { threadFamilies } from "../../state/threads";
import { ThreadContextChip } from "../ThreadContextChip";
import { MarkdownThreadLink } from "./MarkdownThreadLink";

type FamilyResult = ReturnType<ReturnType<typeof threadFamilies.familyAtom>["read"]>;

const mocks = await vi.hoisted(async () => {
  const { Atom, AsyncResult } = await import("effect/reactivity");
  const { EMPTY_SHELL_STATE } = await import("@t3tools/client-runtime/state/shell");
  return {
    shells: Atom.make<ReadonlyMap<string, OrchestrationV2ThreadShell>>(new Map()).pipe(
      Atom.keepAlive,
    ),
    shellStates: Atom.family((_environmentId: EnvironmentId) =>
      Atom.make({ ...EMPTY_SHELL_STATE }).pipe(Atom.keepAlive),
    ),
    reads: Atom.family((_key: string) =>
      Atom.make<FamilyResult>(AsyncResult.initial()).pipe(Atom.keepAlive),
    ),
  };
});

const key = (ref: ScopedThreadRef) => JSON.stringify([ref.environmentId, ref.threadId]);

vi.mock("../../state/entities", () => ({
  useProject: () => null,
  useThreadRefs: (enabled = true) => {
    const rows = useAtomValue(mocks.shells);
    return enabled
      ? [...rows.keys()].map((key) => {
          const [environmentId, threadId] = JSON.parse(key) as [EnvironmentId, ThreadId];
          return { environmentId, threadId };
        })
      : [];
  },
  useThreadShell: (ref: ScopedThreadRef | null) => {
    const rows = useAtomValue(mocks.shells);
    if (ref === null) return null;
    const row = rows.get(key(ref));
    return row ? { ...row, environmentId: ref.environmentId } : null;
  },
}));

vi.mock("../contextChipParts", () => ({
  UnresolvedChip: ({ label }: { label: string }) => <span>{label}</span>,
}));

vi.mock("../ProjectFavicon", () => ({ ProjectFavicon: () => null }));

const ENV = EnvironmentId.make("thread-links-test");
const ref = (id: string, environmentId = ENV): ScopedThreadRef => ({
  environmentId,
  threadId: ThreadId.make(id),
});
const row = (id: string, title: string) =>
  ({ id: ThreadId.make(id), title }) as OrchestrationV2ThreadShell;

function setup(shells: ReadonlyMap<string, OrchestrationV2ThreadShell> = new Map()) {
  const baseShells = new Map(shells);
  const removed = new Set<string>();
  const states = vi.spyOn(environmentShell, "stateValueAtom").mockImplementation(mocks.shellStates);
  appAtomRegistry.set(mocks.shells, baseShells);
  const mounted = new Map<string, OrchestrationV2ThreadFamily>();
  const counts = new Map<string, number>();
  const requested = new Set<string>();
  const publish = () => {
    const rows = new Map(baseShells);
    for (const [familyKey, family] of mounted) {
      const [environmentId] = JSON.parse(familyKey) as [EnvironmentId, ThreadId];
      for (const thread of family.threads) {
        const ref = { environmentId, threadId: thread.id };
        if (!removed.has(key(ref))) rows.set(key(ref), thread);
      }
    }
    appAtomRegistry.set(mocks.shells, rows);
  };
  const queries = vi
    .spyOn(threadFamilies, "familyAtom")
    .mockImplementation((environmentId, threadId) => {
      const id = key({ environmentId, threadId });
      if (!requested.has(id)) {
        requested.add(id);
        appAtomRegistry.set(mocks.reads(id), AsyncResult.initial());
      }
      return mocks.reads(id);
    });
  const mounts = vi
    .spyOn(threadFamilies, "mount")
    .mockImplementation((registry, environmentId, threadId) => {
      const id = key({ environmentId, threadId });
      const query = threadFamilies.familyAtom(environmentId, threadId);
      counts.set(id, (counts.get(id) ?? 0) + 1);
      const unsubscribe = registry.subscribe(
        query,
        (result) => {
          if (AsyncResult.isSuccess(result)) mounted.set(id, result.value);
          else mounted.delete(id);
          publish();
        },
        { immediate: true },
      );
      return () => {
        unsubscribe();
        const count = (counts.get(id) ?? 1) - 1;
        counts.set(id, count);
        if (count === 0) mounted.delete(id);
        publish();
      };
    });
  return {
    requested,
    remove: (target: ScopedThreadRef) =>
      act(() => {
        removed.add(key(target));
        baseShells.delete(key(target));
        const state = mocks.shellStates(target.environmentId);
        appAtomRegistry.set(state, {
          ...appAtomRegistry.get(state),
          removedAt: new Map([[target.threadId, 2]]),
        });
        publish();
      }),
    setShell: (target: ScopedThreadRef, thread: OrchestrationV2ThreadShell | null) =>
      act(() => {
        if (thread === null) baseShells.delete(key(target));
        else baseShells.set(key(target), thread);
        publish();
      }),
    fail: (target: ScopedThreadRef, waiting = false) =>
      act(() =>
        appAtomRegistry.set(
          mocks.reads(key(target)),
          AsyncResult.fail(new Error("offline"), { waiting }),
        ),
      ),
    resolve: (target: ScopedThreadRef, threads: ReadonlyArray<OrchestrationV2ThreadShell>) =>
      act(() =>
        appAtomRegistry.set(
          mocks.reads(key(target)),
          AsyncResult.success({ snapshotSequence: 1, threads }),
        ),
      ),
    [Symbol.dispose]() {
      states.mockRestore();
      for (const environmentId of [ENV, EnvironmentId.make("remote-environment")]) {
        const state = mocks.shellStates(environmentId);
        appAtomRegistry.set(state, { ...appAtomRegistry.get(state), removedAt: new Map() });
      }
      mounts.mockRestore();
      queries.mockRestore();
    },
  };
}

function view(target: ScopedThreadRef, kind: "context" | "markdown" = "markdown", legacy = false) {
  return (
    <AppAtomRegistryProvider>
      {kind === "context" ? (
        <ThreadContextChip record={{ ...target, title: "Saved title" }} />
      ) : (
        <MarkdownThreadLink
          environmentId={ENV}
          link={{ ...target, environmentId: legacy ? null : target.environmentId }}
          label={null}
        />
      )}
    </AppAtomRegistryProvider>
  );
}

describe("thread link family lookups", () => {
  it.each(["context", "markdown"] as const)(
    "retains a settled thread until its %s chip unmounts",
    async (kind) => {
      using fixture = setup();
      const target = ref("older-settled");
      await using screen = await render(view(target, kind));
      await fixture.resolve(target, [row(target.threadId, "Older settled thread")]);
      await expect
        .element(screen.getByRole("link", { name: "Thread, Older settled thread" }))
        .toBeInTheDocument();
      await screen.rerender(view(target, kind));
      await expect
        .element(screen.getByRole("link", { name: "Thread, Older settled thread" }))
        .toBeInTheDocument();
      expect(appAtomRegistry.get(mocks.shells).has(key(target))).toBe(true);
      const listed = ref("already-listed");
      await fixture.setShell(listed, row(listed.threadId, "Listed thread"));
      await screen.rerender(view(listed, kind));
      await expect
        .element(screen.getByRole("link", { name: "Thread, Listed thread" }))
        .toBeInTheDocument();
      expect(fixture.requested.has(key(listed))).toBe(false);
      expect(appAtomRegistry.get(mocks.shells).has(key(target))).toBe(false);
      await fixture.setShell(listed, null);
      await fixture.resolve(listed, [row(listed.threadId, "Listed thread reloaded")]);
      await expect
        .element(screen.getByRole("link", { name: "Thread, Listed thread reloaded" }))
        .toBeInTheDocument();
      await screen.unmount();
      expect(appAtomRegistry.get(mocks.shells).size).toBe(0);
    },
  );

  it.each([false, true])("prefers a literal percent escape, legacy link %s", async (legacy) => {
    const literal = ref("provider%3A1");
    const decoded = ref("provider:1");
    using fixture = setup(new Map([[key(decoded), row(decoded.threadId, "Decoded thread")]]));
    await using screen = await render(view(literal, "markdown", legacy));
    await expect
      .element(screen.getByRole("link", { name: "Thread, Decoded thread" }))
      .not.toBeInTheDocument();
    expect(fixture.requested.has(key(literal))).toBe(true);
    expect(fixture.requested.has(key(decoded))).toBe(false);
    await fixture.fail(literal);
    await expect
      .element(screen.getByRole("link", { name: "Thread, Decoded thread" }))
      .not.toBeInTheDocument();
    await fixture.resolve(literal, [row(literal.threadId, "Literal thread")]);
    await expect
      .element(screen.getByRole("link", { name: "Thread, Literal thread" }))
      .toBeInTheDocument();
    expect(fixture.requested.has(key(decoded))).toBe(false);
  });

  it.each(["written", "decoded"] as const)(
    "resolves a legacy link remotely when the %s family read fails",
    async (lookup) => {
      const literal = ref("provider%3A1");
      const decoded = ref("provider:1");
      const failed = lookup === "written" ? literal : decoded;
      const remote = ref(failed.threadId, EnvironmentId.make("remote-environment"));
      const alternative = ref(decoded.threadId, EnvironmentId.make("decoded-remote-environment"));
      const shells = new Map([[key(remote), row(remote.threadId, "Remote thread")]]);
      if (lookup === "written") {
        shells.set(key(alternative), row(alternative.threadId, "Decoded remote thread"));
      }
      using fixture = setup(shells);
      await using screen = await render(view(literal, "markdown", true));
      if (lookup === "decoded") await fixture.resolve(literal, []);
      await fixture.fail(failed, true);
      await expect
        .element(screen.getByRole("link", { name: "Thread, Remote thread" }))
        .not.toBeInTheDocument();
      await fixture.fail(failed);
      await expect
        .element(screen.getByRole("link", { name: "Thread, Remote thread" }))
        .toBeInTheDocument();
      expect(fixture.requested.has(key(remote))).toBe(false);
      await fixture.setShell(remote, null);
      expect(fixture.requested.has(key(remote))).toBe(true);
      await expect
        .element(screen.getByRole("link", { name: "Thread, Decoded remote thread" }))
        .not.toBeInTheDocument();
      await fixture.fail(remote);
      await expect
        .element(screen.getByRole("link", { name: "Thread, Decoded remote thread" }))
        .not.toBeInTheDocument();
      await fixture.resolve(remote, [row(remote.threadId, "Remote thread reloaded")]);
      await expect
        .element(screen.getByRole("link", { name: "Thread, Remote thread reloaded" }))
        .toBeInTheDocument();
      const duplicate = ref(remote.threadId, EnvironmentId.make("another-remote-environment"));
      await fixture.setShell(duplicate, row(duplicate.threadId, "Ambiguous remote thread"));
      await expect
        .element(screen.getByRole("link", { name: "Thread, Remote thread reloaded" }))
        .not.toBeInTheDocument();
      await fixture.setShell(duplicate, null);
      await expect
        .element(screen.getByRole("link", { name: "Thread, Remote thread reloaded" }))
        .toBeInTheDocument();
      if (lookup === "written") {
        await fixture.remove(remote);
        await expect
          .element(screen.getByRole("link", { name: "Thread, Decoded remote thread" }))
          .toBeInTheDocument();
      } else {
        const preferred = ref(literal.threadId, EnvironmentId.make("written-remote-environment"));
        await fixture.setShell(preferred, row(preferred.threadId, "Preferred written remote"));
        await expect
          .element(screen.getByRole("link", { name: "Thread, Preferred written remote" }))
          .toBeInTheDocument();
      }
      const next = ref("different-thread");
      await screen.rerender(view(next, "markdown", true));
      await fixture.fail(next);
      await expect
        .element(screen.getByRole("link", { name: "Thread, Remote thread reloaded" }))
        .not.toBeInTheDocument();
      await expect
        .element(screen.getByRole("link", { name: "Thread, Decoded remote thread" }))
        .not.toBeInTheDocument();
      await expect
        .element(screen.getByRole("link", { name: "Thread, Preferred written remote" }))
        .not.toBeInTheDocument();
      expect(appAtomRegistry.get(mocks.shells).has(key(remote))).toBe(false);
    },
  );

  it("tries the decoded ID only after a successful empty literal lookup", async () => {
    using fixture = setup();
    const literal = ref("provider%3A1");
    const decoded = ref("provider:1");
    await using screen = await render(view(literal));
    expect(fixture.requested.has(key(decoded))).toBe(false);
    await fixture.resolve(literal, []);
    expect(fixture.requested.has(key(decoded))).toBe(true);
    await fixture.resolve(decoded, [row(decoded.threadId, "Decoded thread")]);
    await expect
      .element(screen.getByRole("link", { name: "Thread, Decoded thread" }))
      .toBeInTheDocument();
  });

  it("releases the previous family when the target environment changes", async () => {
    using fixture = setup();
    const first = ref("same-id");
    const second = ref("same-id", EnvironmentId.make("second-environment"));
    await using screen = await render(view(first));
    await fixture.resolve(first, [row(first.threadId, "First environment")]);
    await screen.rerender(view(second));
    await fixture.resolve(second, [row(second.threadId, "Second environment")]);
    await expect
      .element(screen.getByRole("link", { name: "Thread, Second environment" }))
      .toBeInTheDocument();
    expect(appAtomRegistry.get(mocks.shells).has(key(first))).toBe(false);
  });
});
