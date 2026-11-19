import { RegistryContext } from "@effect/atom-react";
import { mergeLinkedThreadPage } from "@t3tools/client-runtime/linked-thread";
import { EnvironmentId, type PeerLinkThreadPage, ThreadId, TurnItemId } from "@t3tools/contracts";
import { Atom, AtomRegistry } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import "../../index.css";

import { LinkedThreadSheet } from "./LinkedThreadSheet";

const state = vi.hoisted(() => ({ view: null as unknown, transcript: null as unknown }));
vi.mock(import("../../state/linkedThreadView"), async () => {
  const reactivity = await import("effect/reactivity");
  state.view = reactivity.Atom.make<unknown>(null);
  return {
    linkedThreadViewAtom: state.view as never,
    useOpenLinkedThread: () => () => {},
    useLinkedThreadOpener: () => null,
    useLinkedThreadSession: () =>
      ({
        state: { transcript: state.transcript, error: null, loadingEarlier: false },
        session: { retry: () => {}, loadEarlier: async () => {} },
      }) as never,
  };
});

const threadId = ThreadId.make("thread:box");
const item = (
  position: number,
  type: string,
  text: string,
): PeerLinkThreadPage["items"][number] => ({
  position,
  visibility: "local",
  sourceThreadId: threadId,
  itemId: TurnItemId.make(`item:${position}`),
  runId: null,
  messageId: null,
  createdBy: null,
  creationSource: null,
  type,
  status: "completed",
  title: null,
  text,
  textTruncated: false,
  updatedAt: "2026-11-19T00:00:00.000Z",
});

it("shows the user's message and a fenced block's code, with a close button", async () => {
  const target = {
    viaEnvironmentId: EnvironmentId.make("laptop"),
    environmentId: EnvironmentId.make("box"),
    threadId,
    label: "Box",
    title: null,
  };
  state.transcript = mergeLinkedThreadPage(
    null,
    {
      label: "Box",
      thread: { threadId, title: "Fix flaky checkout test", status: "idle", model: "showcase" },
      items: [
        item(0, "user_message", "Find out why the checkout test is flaky"),
        item(1, "command_execution", "$ Preparing workspace\nWorkspace preparation completed."),
        item(2, "assistant_message", "## Done\n\n```ts\nclamp(12, 0, 10); // 10\n```\n\nThe end."),
      ],
      earlierPosition: null,
      hasMore: false,
    },
    "later",
  );
  const registry = AtomRegistry.make();
  const view = state.view as Atom.Writable<typeof target | null>;
  registry.set(view, target);
  using _registry = { [Symbol.dispose]: () => registry.dispose() };
  await using _screen = await render(
    <RegistryContext value={registry}>
      <LinkedThreadSheet />
    </RegistryContext>,
  );
  await expect.element(page.getByText("Find out why the checkout test is flaky")).toBeVisible();
  await expect.element(page.getByText("clamp(12, 0, 10); // 10")).toBeVisible();
  await page.getByRole("button", { name: "Close" }).click();
  expect(registry.get(view)).toBeNull();
});
