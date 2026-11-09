import { EnvironmentId, ProjectId, ThreadId, type ScopedThreadRef } from "@t3tools/contracts";
import { presentThreadShell } from "@t3tools/client-runtime/state/shell";
import { v2ThreadShell } from "../../../../packages/client-runtime/src/state/orchestrationV2TestFixtures";
import * as Cause from "effect/Cause";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { parseThreadLinkHref } from "@t3tools/shared/threadLinks";

const state = vi.hoisted(() => ({
  reply: null as unknown,
  registry: null as AtomRegistry.AtomRegistry | null,
}));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: <A>(atom: Atom.Atom<A>) => state.registry!.get(atom),
}));
vi.mock("./threads", async () => {
  const { Atom } = await import("effect/reactivity");
  const shells = Atom.make<ReadonlyMap<string, unknown>>(new Map());
  return {
    environmentThreadDetails: {},
    environmentThreadShells: {
      threadShellAtom: (ref: { threadId: string }) =>
        Atom.make((get) => get(shells).get(ref.threadId) ?? null),
      threadRefsAtom: Atom.make([{ environmentId: "remote", threadId: "older-thread" }]),
    },
    testShells: shells,
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

import { resolveThreadLink, useLiveThreadLinkLabels } from "./entities";

function setup() {
  const reply = Atom.make<
    AsyncResult.AsyncResult<Record<string, { title: string; projectId: ProjectId | null }>, string>
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

const environmentId = EnvironmentId.make("7a31051f-0548-4565-b69f-360ed083efb5");
const threadId = ThreadId.make("56032bd4-f15e-4d85-8e84-e3c1a58ae546");
const href = `t3-thread://v2/${environmentId}/${threadId}`;
const markdown = `Resumed <${href}> with Opus on high, fast mode off.`;
const target = {
  ...v2ThreadShell,
  id: threadId,
  projectId: ProjectId.make("synthetic-other-project"),
  title: "Plan Recurring Cashflows for Instruments",
  lineage: { rootThreadId: threadId, parentThreadId: null, relationshipToParent: null },
} satisfies typeof v2ThreadShell;

it("labels and opens a raw v2 link to an existing cross-project thread omitted from the shell", () => {
  const { registry, reply } = setup();
  using _registry = { [Symbol.dispose]: () => registry.dispose() };
  registry.set(reply, AsyncResult.success({}));
  expect(useLiveThreadLinkLabels(markdown, environmentId)).toBe(
    "Resumed Thread no longer available with Opus on high, fast mode off.",
  );
  registry.set(
    reply,
    AsyncResult.success({ [threadId]: { title: target.title, projectId: target.projectId } }),
  );
  expect(useLiveThreadLinkLabels(markdown, environmentId)).toBe(
    `Resumed [${target.title}](${href}) with Opus on high, fast mode off.`,
  );
  const link = parseThreadLinkHref(href);
  expect(link && resolveThreadLink(registry.get.bind(registry), link, environmentId)).toEqual({
    environmentId,
    threadId,
  });
});

it("prefers the live shell title over the metadata lookup", async () => {
  const { registry, reply } = setup();
  using _registry = { [Symbol.dispose]: () => registry.dispose() };
  const { testShells } = await vi.importMock<{
    testShells: Atom.Writable<ReadonlyMap<string, unknown>>;
  }>("./threads");
  registry.set(
    reply,
    AsyncResult.success({ [threadId]: { title: target.title, projectId: target.projectId } }),
  );
  registry.set(
    testShells,
    new Map([
      [threadId, presentThreadShell(environmentId, { ...target, title: "Renamed thread" })],
    ]),
  );
  expect(useLiveThreadLinkLabels(markdown, environmentId)).toBe(
    `Resumed [Renamed thread](${href}) with Opus on high, fast mode off.`,
  );
});
