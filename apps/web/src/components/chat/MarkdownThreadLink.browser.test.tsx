import { RegistryContext } from "@effect/atom-react";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

import { act, render } from "../../../test/render";
import { MarkdownThreadLink } from "./MarkdownThreadLink";

const state = vi.hoisted(() => ({ reply: null as unknown }));
vi.mock(import("../../state/entities"), () => ({
  useThreadShell: () => null,
  useThreadRefs: () => [],
  useProject: () => null,
}));
vi.mock(import("../contextChipParts"), () => ({
  UnresolvedChip: ({ label }: { label: string }) => <span>{label}</span>,
}));
vi.mock(import("../../state/orchestration"), () => ({
  orchestrationEnvironment: { threadTitles: () => state.reply } as never,
}));

function setup() {
  const reply = Atom.make<AsyncResult.AsyncResult<Record<string, string>, string>>(
    AsyncResult.initial(),
  );
  state.reply = reply;
  return { reply, registry: AtomRegistry.make() };
}

it("opens an older thread absent from the shell after resolving its title", async () => {
  const { reply, registry } = setup();
  using _registry = { [Symbol.dispose]: () => registry.dispose() };
  const environmentId = EnvironmentId.make("environment");
  const threadId = ThreadId.make("older-thread");
  await using screen = await render(
    <RegistryContext value={registry}>
      <MarkdownThreadLink
        environmentId={environmentId}
        link={{ environmentId, threadId }}
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
  await act(() => registry.set(reply, AsyncResult.success({ [threadId]: "Older essay" })));
  const link = screen.getByRole("link", { name: "Thread, Older essay" });
  await expect.element(link).toBeVisible();
  await link.click();
  expect(screen.router?.state.location.pathname).toBe("/environment/older-thread");
  await act(() => registry.set(reply, AsyncResult.success({})));
  await expect
    .element(screen.getByText("Thread no longer available", { exact: true }))
    .toBeVisible();
});
