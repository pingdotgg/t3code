import { EnvironmentId, ProjectId, ThreadId, type ScopedThreadRef } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({ reply: null as unknown }));
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
vi.mock(import("./projects"), () => ({ environmentProjects: {} as never }));
vi.mock(import("./server"), () => ({
  environmentServerConfigsAtom: {} as never,
  serverEnvironment: {} as never,
}));
vi.mock(import("./assets"), () => ({ projectFaviconUrlAtom: (() => null) as never }));
vi.mock(import("../native/ProjectChipIconImages"), () => ({
  projectGlyphImageAtom: (() => null) as never,
  projectGlyphKey: (() => "") as never,
}));

import { resolveThreadLink } from "./entities";

function setup() {
  const reply = Atom.make<
    AsyncResult.AsyncResult<Record<string, { title: string; projectId: ProjectId | null }>, string>
  >(AsyncResult.initial());
  state.reply = reply;
  return { registry: AtomRegistry.make(), reply };
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
