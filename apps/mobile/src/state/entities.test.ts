import {
  ComposerContextId,
  EnvironmentId,
  ProjectId,
  ThreadId,
  type OrchestrationV2ThreadLinkMetadata,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({ reply: null as unknown, registry: null as unknown }));
vi.mock(import("@effect/atom-react"), () => ({
  useAtomValue: ((atom: Atom.Atom<unknown>) =>
    (state.registry as AtomRegistry.AtomRegistry).get(atom)) as never,
}));
vi.mock(import("./threads"), async () => {
  const { Atom } = await import("effect/reactivity");
  return {
    environmentThreadDetails: {} as never,
    environmentThreadShells: {
      threadShellAtom: () => Atom.make(null),
      threadRefsAtom: Atom.make([{ environmentId: "remote", threadId: "older-thread" }]),
    } as never,
  };
});
vi.mock(import("./orchestration"), () => ({
  orchestrationEnvironment: { threadLinkMetadata: () => state.reply } as never,
}));
vi.mock(import("./atom-registry"), () => ({ appAtomRegistry: {} as never }));
vi.mock(import("./projects"), async () => {
  const { Atom } = await import("effect/reactivity");
  const project = Atom.make({ title: "Demo", workspaceRoot: "/work/demo" });
  return { environmentProjects: { projectAtom: () => project } as never };
});
vi.mock(import("./server"), async () => {
  const { Atom } = await import("effect/reactivity");
  const config = Atom.make(null);
  return {
    environmentServerConfigsAtom: {} as never,
    serverEnvironment: { configValueAtom: () => config } as never,
  };
});
vi.mock(import("./assets"), async () => {
  const { Atom } = await import("effect/reactivity");
  const favicon = Atom.make("https://example.test/favicon.png");
  return { projectFaviconUrlAtom: (() => favicon) as never };
});
vi.mock(import("../native/ProjectChipIconImages"), () => ({
  projectGlyphImageAtom: (() => null) as never,
  projectGlyphKey: (() => "") as never,
}));

import { resolveThreadLink, useThreadChipPresentations } from "./entities";

function setup() {
  const reply = Atom.make<
    AsyncResult.AsyncResult<Record<string, OrchestrationV2ThreadLinkMetadata>, string>
  >(AsyncResult.initial());
  state.reply = reply;
  const registry = AtomRegistry.make();
  state.registry = registry;
  return { registry, reply };
}

it("uses confirmed matches instead of provisional titles when resolving legacy links", () => {
  const { registry, reply } = setup();
  using _registry = { [Symbol.dispose]: () => registry.dispose() };
  const local: ScopedThreadRef = {
    environmentId: EnvironmentId.make("local"),
    threadId: ThreadId.make("older-thread"),
  };
  const remote: ScopedThreadRef = { ...local, environmentId: EnvironmentId.make("remote") };
  const link = { environmentId: null, threadId: local.threadId };
  const resolve = () => resolveThreadLink(registry.get.bind(registry), link, local.environmentId);
  const release = registry.mount(reply);
  try {
    expect(resolve()).toEqual(remote);
    registry.set(reply, AsyncResult.failure(Cause.fail("offline")));
    expect(resolve()).toEqual(remote);
    expect(resolveThreadLink(registry.get.bind(registry), local, remote.environmentId)).toEqual(
      local,
    );
    registry.set(
      reply,
      AsyncResult.success({
        [local.threadId]: { title: "Thread", projectId: ProjectId.make("project") },
      }),
    );
    expect(resolve()).toEqual(local);
    registry.set(reply, AsyncResult.success({}));
    expect(resolve()).toEqual(remote);
  } finally {
    release();
  }
});

it("shows archive status in linked and mentioned thread chips and restores the project icon", () => {
  const { registry, reply } = setup();
  using _registry = { [Symbol.dispose]: () => registry.dispose() };
  const environmentId = EnvironmentId.make("local");
  const threadId = ThreadId.make("earlier-work");
  const metadata = { title: "Earlier work", projectId: ProjectId.make("project") };
  const href = "t3-thread://v1/earlier-work";
  const mentionHref = "t3-context://v1/thread/thread-context";
  const chips = () =>
    useThreadChipPresentations(environmentId, `[Earlier work](${href})`, [
      {
        version: 1,
        kind: "thread",
        contextId: ComposerContextId.make("thread-context"),
        environmentId,
        threadId,
        title: "Earlier work",
        label: "Earlier work",
      },
    ]);

  registry.set(reply, AsyncResult.success({ [threadId]: { ...metadata, archived: true } }));
  const archived = { kind: "archived", title: "Earlier work" };
  expect(chips()).toEqual(
    new Map([
      [href, archived],
      [mentionHref, archived],
    ]),
  );

  registry.set(reply, AsyncResult.success({ [threadId]: metadata }));
  const project = { kind: "project", uri: "https://example.test/favicon.png" };
  expect(chips()).toEqual(
    new Map([
      [href, project],
      [mentionHref, project],
    ]),
  );
});
