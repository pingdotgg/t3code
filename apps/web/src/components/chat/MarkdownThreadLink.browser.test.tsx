import { RegistryContext } from "@effect/atom-react";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

import { act, render } from "../../../test/render";
import { MarkdownThreadLink } from "./MarkdownThreadLink";

const state = vi.hoisted(() => ({
  reply: null as unknown,
  remote: null as unknown,
}));
vi.mock(import("../../state/entities"), () => ({
  useThreadShell: ((ref: { environmentId: string } | null) =>
    ref?.environmentId === "remote" ? state.remote : null) as never,
  useThreadRefs: (enabled = true) =>
    enabled
      ? [{ environmentId: EnvironmentId.make("remote"), threadId: ThreadId.make("older-thread") }]
      : [],
  useProject: (ref: { projectId: string } | null) =>
    ref?.projectId === "essay-project" ? ({ title: "Essays" } as never) : null,
}));
vi.mock(import("../../state/environments"), () => ({
  useEnvironmentIdentities: () => [
    { environmentId: EnvironmentId.make("environment"), label: "Here" },
    { environmentId: EnvironmentId.make("remote"), label: "Remote" },
  ],
}));
vi.mock(import("../ProjectFavicon"), () => ({
  ProjectFavicon: () => (
    <span role="img" aria-label="Essays project icon">
      P
    </span>
  ),
}));
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
  state.remote = {
    environmentId: EnvironmentId.make("remote"),
    id: ThreadId.make("older-thread"),
    title: "Remote thread",
    projectId: ProjectId.make("essay-project"),
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
