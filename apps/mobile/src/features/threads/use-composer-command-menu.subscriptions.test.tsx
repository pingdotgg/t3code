// @vitest-environment jsdom
import { RegistryContext } from "@effect/atom-react";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { PrimaryConnectionTarget } from "@t3tools/client-runtime/connection";
import {
  v2ShellSnapshot,
  v2ThreadShell,
} from "../../../../../packages/client-runtime/src/state/orchestrationV2TestFixtures";
import { createEnvironmentThreadShellAtoms } from "@t3tools/client-runtime/state/threads";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { Atom, AtomRegistry } from "effect/reactivity";
import { act, createElement, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const harness = vi.hoisted(() => ({ threads: {} }));
vi.mock("../../state/threads", () => ({
  environmentThreadShells: harness.threads,
}));
vi.mock("../../state/server", () => ({
  serverEnvironment: { refreshProviders: null },
}));
vi.mock("../../state/queries", () => ({
  useComposerPathSearch: () => ({ entries: [], isPending: false }),
  useComposerPullRequestSearch: () => ({ entries: [], isPending: false, error: null }),
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("../../state/use-composer-drafts", () => ({
  readComposerDraftSelection: () => null,
  getComposerDraftSnapshot: vi.fn(),
  setComposerDraftContext: vi.fn(),
}));
vi.mock("react-native", () => ({ Alert: { alert: vi.fn() } }));
vi.mock("../../lib/uuid", () => ({ uuidv4: () => "context-id" }));

import { useComposerCommandMenu } from "./use-composer-command-menu";

const environmentId = EnvironmentId.make("environment-v2");
const remoteEnvironmentId = EnvironmentId.make("remote-environment");
const otherThread = { ...v2ThreadShell, id: ThreadId.make("other"), title: "Other task" };
const snapshotAtom = Atom.family(() =>
  Atom.make({ ...v2ShellSnapshot, threads: [v2ThreadShell, otherThread] }),
);
const catalogValueAtom = Atom.make({
  isReady: true,
  entries: new Map(
    [environmentId, remoteEnvironmentId].map((id) => [
      id,
      {
        target: new PrimaryConnectionTarget({
          environmentId: id,
          label: id,
          httpBaseUrl: "https://example.test",
          wsBaseUrl: "wss://example.test",
        }),
        profile: Option.none(),
        enabled: true,
      },
    ]),
  ),
});
Object.assign(
  harness.threads,
  createEnvironmentThreadShellAtoms({ catalogValueAtom, snapshotAtom }),
);

describe("composer thread suggestion subscriptions", () => {
  let registry: AtomRegistry.AtomRegistry;
  let root: Root;
  let commits: number;
  let menu: ReturnType<typeof useComposerCommandMenu>;

  function Probe({
    draftMessage,
    hasThread,
    enabled = true,
    env = environmentId,
  }: {
    draftMessage: string;
    hasThread: boolean;
    enabled?: boolean;
    env?: EnvironmentId | null;
  }) {
    const composerMenu = useComposerCommandMenu({
      draftMessage,
      hasThread,
      enabled,
      environmentId: env,
      currentThreadId: hasThread ? v2ThreadShell.id : null,
      ownerKey: null,
      projectCwd: null,
      selectedProviderStatus: null,
      hasCompactableConversation: false,
      onChangeDraftMessage: () => {},
    });
    useEffect(() => {
      menu = composerMenu;
      commits += 1;
    });
    return null;
  }

  function render(props: Parameters<typeof Probe>[0]) {
    act(() =>
      root.render(
        createElement(RegistryContext.Provider, { value: registry }, createElement(Probe, props)),
      ),
    );
    act(() =>
      menu.onSelectionChange({ start: props.draftMessage.length, end: props.draftMessage.length }),
    );
  }

  function updateShells(env: EnvironmentId, count = 100) {
    const before = commits;
    for (let index = 0; index < count; index += 1) {
      act(() =>
        registry.update(snapshotAtom(env), (snapshot) => ({
          ...snapshot,
          snapshotSequence: snapshot.snapshotSequence + 1,
          threads: snapshot.threads.map((thread) =>
            thread.id !== v2ThreadShell.id
              ? {
                  ...thread,
                  updatedAt: DateTime.makeUnsafe(1780000000000 + snapshot.snapshotSequence),
                }
              : thread,
          ),
        })),
      );
    }
    return commits - before;
  }

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    registry = AtomRegistry.make();
    root = createRoot(document.createElement("div"));
    commits = 0;
  });
  afterEach(() => {
    act(() => root.unmount());
    registry.dispose();
    vi.unstubAllGlobals();
  });

  it.each([true, false])(
    "ignores shell updates with closed autocomplete, hasThread=%s",
    (hasThread) => {
      render({ draftMessage: "plain unsent text", hasThread });
      const localRenders = updateShells(environmentId);
      const remoteRenders = updateShells(remoteEnvironmentId);
      expect(menu.items).toEqual([]);
      expect(localRenders).toBe(0);
      expect(remoteRenders).toBe(0);
    },
  );

  it.each([true, false])(
    "keeps open suggestions live and unsubscribes when closed, hasThread=%s",
    (hasThread) => {
      render({ draftMessage: "@Other", hasThread });
      expect(menu.items.map((item) => item.label)).toEqual(["Other task"]);
      expect(updateShells(remoteEnvironmentId)).toBe(0);
      expect(updateShells(environmentId)).toBe(100);
      act(() =>
        registry.update(snapshotAtom(environmentId), (snapshot) => ({
          ...snapshot,
          threads: snapshot.threads.map((thread) =>
            thread.id === otherThread.id ? { ...thread, title: "Other renamed" } : thread,
          ),
        })),
      );
      expect(menu.items.map((item) => item.label)).toEqual(["Other renamed"]);
      act(() =>
        registry.update(snapshotAtom(environmentId), (snapshot) => ({
          ...snapshot,
          threads: [
            ...snapshot.threads,
            { ...otherThread, id: ThreadId.make("added"), title: "Other added" },
          ],
        })),
      );
      expect(menu.items.map((item) => item.label)).toContain("Other added");
      act(() =>
        registry.update(snapshotAtom(environmentId), (snapshot) => ({
          ...snapshot,
          threads: snapshot.threads.filter((thread) => thread.id !== otherThread.id),
        })),
      );
      expect(menu.items.map((item) => item.label)).toEqual(["Other added"]);
      render({ draftMessage: "plain text", hasThread });
      expect(menu.items).toEqual([]);
      expect(updateShells(environmentId)).toBe(0);
      render({ draftMessage: "@Other", hasThread });
      expect(menu.items.map((item) => item.label)).toEqual(["Other added"]);
      render({ draftMessage: "@Other", hasThread, enabled: false });
      expect(menu.items).toEqual([]);
      expect(updateShells(environmentId)).toBe(0);
    },
  );
  it("switches environments and stops reading shells with no environment or caret trigger", () => {
    render({ draftMessage: "@Other", hasThread: false });
    act(() =>
      registry.update(snapshotAtom(remoteEnvironmentId), (snapshot) => ({
        ...snapshot,
        threads: [{ ...otherThread, title: "Other remote" }],
      })),
    );
    render({ draftMessage: "@Other", hasThread: false, env: remoteEnvironmentId });
    expect(menu.items.map((item) => item.label)).toEqual(["Other remote"]);
    expect(updateShells(environmentId)).toBe(0);
    expect(updateShells(remoteEnvironmentId)).toBe(100);
    act(() => menu.onSelectionChange({ start: 0, end: 6 }));
    expect(menu.items).toEqual([]);
    expect(updateShells(remoteEnvironmentId)).toBe(0);
    render({ draftMessage: "@Other", hasThread: false, env: null });
    expect(menu.items).toEqual([]);
    expect(updateShells(remoteEnvironmentId)).toBe(0);
  });
  it("does not subscribe to thread suggestions for a bare @", () => {
    render({ draftMessage: "@", hasThread: false });
    expect(menu.items).toEqual([]);
    expect(updateShells(environmentId)).toBe(0);
    expect(updateShells(remoteEnvironmentId)).toBe(0);
  });
});
