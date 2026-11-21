import { RegistryContext } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

import { act, render } from "../../../test/render";
import { isMacPlatform } from "../../lib/utils";
import { linkedThreadSurface } from "../../linkedThreadSurface";
import { selectThreadRightPanelState, useRightPanelStore } from "../../rightPanelStore";
import { MarkdownThreadLink } from "./MarkdownThreadLink";

const HERE = scopeThreadRef(EnvironmentId.make("environment"), ThreadId.make("here"));
const panel = () => selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, HERE);

const state = vi.hoisted(() => ({
  reply: null as unknown,
  remote: null as unknown,
  cached: null as unknown,
  linked: new Map<string, string>(),
  connected: [] as Array<string>,
}));
vi.mock(import("../../state/entities"), () => ({
  useThreadShell: ((ref: { environmentId: string } | null) =>
    ref?.environmentId === "remote"
      ? state.remote
      : ref?.environmentId === "saved-vm"
        ? state.cached
        : null) as never,
  useThreadRefs: (enabled = true) =>
    enabled
      ? [{ environmentId: EnvironmentId.make("remote"), threadId: ThreadId.make("older-thread") }]
      : [],
  useProject: (ref: { projectId: string } | null) =>
    ref?.projectId === "essay-project" ? ({ title: "Essays" } as never) : null,
}));
vi.mock(import("../../state/environments"), () => ({
  // The click rule reads the client setting, whose module asks for these.
  useEnvironments: (() => []) as never,
  usePrimaryEnvironment: (() => null) as never,
  useEnvironmentIdentities: () => [
    { environmentId: EnvironmentId.make("environment"), label: "Here" },
    { environmentId: EnvironmentId.make("remote"), label: "Remote" },
    { environmentId: EnvironmentId.make("saved-vm"), label: "Saved VM" },
  ],
  useConnectedEnvironmentIds: () => state.connected as never,
}));
vi.mock(import("../../state/peerLinks"), () => ({
  useLinkedEnvironments: ((environmentId: string | null) =>
    environmentId === null ? new Map() : state.linked) as never,
}));
vi.mock(import("../ProjectFavicon"), () => ({
  ProjectFavicon: () => (
    <span role="img" aria-label="Essays project icon">
      P
    </span>
  ),
}));
vi.mock(import("../ThreadChipHoverCard"), () => ({ ThreadChipHoverCard: () => <span /> }));
vi.mock(import("../contextChipParts"), () => ({
  UnresolvedChip: ({ label }: { label: string }) => <span>{label}</span>,
}));
vi.mock(import("../../state/orchestration"), () => ({
  orchestrationEnvironment: { threadLinkMetadata: () => state.reply } as never,
}));

function setup() {
  const reply = Atom.make<
    AsyncResult.AsyncResult<Record<string, { title: string; projectId: ProjectId | null }>, string>
  >(AsyncResult.initial());
  state.reply = reply;
  state.linked = new Map();
  state.cached = null;
  state.connected = ["environment", "remote"];
  useRightPanelStore.setState({ byThreadKey: {} });
  state.remote = {
    environmentId: EnvironmentId.make("remote"),
    id: ThreadId.make("older-thread"),
    title: "Remote thread",
    projectId: ProjectId.make("essay-project"),
    lineage: {
      rootThreadId: ThreadId.make("older-thread"),
      parentThreadId: null,
      relationshipToParent: null,
    },
  };
  return { reply, registry: AtomRegistry.make() };
}

it.each([
  { legacy: false, encoded: false },
  { legacy: true, encoded: false },
  { legacy: false, encoded: true },
])(
  "resolves an unloaded thread with its icon and the correct destination, %j",
  async ({ legacy, encoded }) => {
    const { reply, registry } = setup();
    using _registry = { [Symbol.dispose]: () => registry.dispose() };
    const environmentId = EnvironmentId.make("environment");
    const threadId = ThreadId.make(encoded ? "older%2Dthread" : "older-thread");
    await using screen = await render(
      <RegistryContext value={registry}>
        <MarkdownThreadLink
          environmentId={environmentId}
          link={{ environmentId: legacy ? null : environmentId, threadId }}
          label={null}
        />
      </RegistryContext>,
    );
    await expect
      .element(screen.getByRole("link", { name: "Thread, Thread", exact: true }))
      .toBeVisible();
    await act(() => registry.set(reply, AsyncResult.failure(Cause.fail("offline"))));
    await expect
      .element(screen.getByRole("link", { name: "Thread, Thread", exact: true }))
      .toBeVisible();
    await act(() =>
      registry.set(
        reply,
        AsyncResult.success({
          [threadId]: { title: "Older essay", projectId: ProjectId.make("essay-project") },
          ...(encoded
            ? {
                "older-thread": {
                  title: "Decoded essay",
                  projectId: ProjectId.make("essay-project"),
                },
              }
            : {}),
        }),
      ),
    );
    const link = screen.getByRole("link", { name: "Thread, Older essay" });
    await expect.element(link).toBeVisible();
    await expect.element(screen.getByRole("img", { name: "Essays project icon" })).toBeVisible();
    await link.click();
    await vi.waitFor(() =>
      expect(screen.router?.state.location.pathname).toBe(
        `/environment/${encodeURIComponent(threadId)}`,
      ),
    );
    if (encoded) {
      await act(() =>
        registry.set(
          reply,
          AsyncResult.success({
            "older-thread": { title: "Decoded essay", projectId: ProjectId.make("essay-project") },
          }),
        ),
      );
      const decoded = screen.getByRole("link", { name: "Thread, Decoded essay" });
      await expect.element(decoded).toBeVisible();
      await decoded.click();
      await vi.waitFor(() =>
        expect(screen.router?.state.location.pathname).toBe("/environment/older-thread"),
      );
    }
    await act(() => registry.set(reply, AsyncResult.success({})));
    if (legacy) {
      const remote = screen.getByRole("link", { name: "Thread, Remote thread" });
      await expect.element(remote).toBeVisible();
      await remote.click();
      await vi.waitFor(() =>
        expect(screen.router?.state.location.pathname).toBe("/remote/older-thread"),
      );
    } else {
      await expect
        .element(screen.getByText("Thread no longer available", { exact: true }))
        .toBeVisible();
    }
  },
);

it("names a thread on a machine this client has no connection to, without waiting on it", async () => {
  const { registry } = setup();
  using _registry = { [Symbol.dispose]: () => registry.dispose() };
  await using screen = await render(
    <RegistryContext value={registry}>
      <MarkdownThreadLink
        environmentId={EnvironmentId.make("environment")}
        link={{ environmentId: EnvironmentId.make("peer"), threadId: ThreadId.make("peer-thread") }}
        label={null}
      />
    </RegistryContext>,
  );
  await expect
    .element(screen.getByText("Thread on another machine", { exact: true }))
    .toBeVisible();
  await expect.element(screen.getByRole("link")).not.toBeInTheDocument();
});

it.for([
  { name: "a machine only this environment links to", linkedId: "linked-vm" },
  { name: "a saved machine this client is not connected to", linkedId: "saved-vm" },
])("opens a thread on $name as a read through the link", async ({ linkedId }) => {
  const { registry } = setup();
  using _registry = { [Symbol.dispose]: () => registry.dispose() };
  state.linked = new Map([[linkedId, "fs-17"]]);
  const environmentId = EnvironmentId.make("environment");
  const link = { environmentId: EnvironmentId.make(linkedId), threadId: ThreadId.make("there") };
  await using screen = await render(
    <RegistryContext value={registry}>
      <MarkdownThreadLink environmentId={environmentId} threadRef={HERE} link={link} label={null} />
    </RegistryContext>,
  );
  const chip = screen.getByRole("button", { name: "Thread, Thread on fs-17" });
  await chip.click();
  const surface = linkedThreadSurface({
    viaEnvironmentId: environmentId,
    ...link,
    label: "fs-17",
    title: null,
  });
  expect(panel()).toMatchObject({ isOpen: true, activeSurfaceId: surface.id, surfaces: [surface] });
  await chip.click();
  expect(panel().surfaces).toHaveLength(1);
  expect(screen.router?.state.location.pathname).toBe("/");
  // The modifier reads it on the main screen instead, through the same environment.
  await chip.click({ modifiers: [isMacPlatform(navigator.platform) ? "Meta" : "Control"] });
  await vi.waitFor(() =>
    expect(screen.router?.state.location.pathname).toBe(`/linked/environment/${linkedId}/there`),
  );
  expect(panel().surfaces).toHaveLength(1);
});

it("reads through the link when a disconnected machine's thread is only cached here", async () => {
  const { registry } = setup();
  using _registry = { [Symbol.dispose]: () => registry.dispose() };
  state.linked = new Map([["saved-vm", "fs-17"]]);
  state.cached = { id: ThreadId.make("there"), title: "Cached title", projectId: null };
  const environmentId = EnvironmentId.make("environment");
  const link = { environmentId: EnvironmentId.make("saved-vm"), threadId: ThreadId.make("there") };
  await using screen = await render(
    <RegistryContext value={registry}>
      <MarkdownThreadLink environmentId={environmentId} threadRef={HERE} link={link} label={null} />
    </RegistryContext>,
  );
  await screen.getByRole("button", { name: "Thread, Cached title" }).click();
  expect(panel().surfaces).toEqual([
    linkedThreadSurface({
      viaEnvironmentId: environmentId,
      ...link,
      label: "fs-17",
      title: "Cached title",
    }),
  ]);
});

it("opens a linked machine's thread directly once this client is connected to it", async () => {
  const { registry, reply } = setup();
  using _registry = { [Symbol.dispose]: () => registry.dispose() };
  state.linked = new Map([["saved-vm", "fs-17"]]);
  state.connected = ["environment", "saved-vm"];
  registry.set(reply, AsyncResult.success({ there: { title: "Fix the build", projectId: null } }));
  await using screen = await render(
    <RegistryContext value={registry}>
      <MarkdownThreadLink
        environmentId={EnvironmentId.make("environment")}
        threadRef={HERE}
        link={{ environmentId: EnvironmentId.make("saved-vm"), threadId: ThreadId.make("there") }}
        label={null}
      />
    </RegistryContext>,
  );
  await expect.element(screen.getByText("Fix the build")).toBeVisible();
  await expect.element(screen.getByRole("button")).not.toBeInTheDocument();
});
