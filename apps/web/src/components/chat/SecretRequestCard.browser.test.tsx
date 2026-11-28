import type { SecretRequestItem } from "@t3tools/client-runtime/secret-request";
import { EnvironmentId, ThreadId, TurnItemId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { AsyncResult } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";

const state = vi.hoisted(() => ({ answer: vi.fn() }));

vi.mock(import("../../state/session"), async (original) => ({
  ...(await original()),
  useEnvironmentScope: () => false,
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => state.answer }));
vi.mock(import("../../state/server"), async (original) => {
  const actual = await original();
  const { Atom } = await import("effect/reactivity");
  const noConfig = Atom.make(null);
  return {
    ...actual,
    serverEnvironment: { ...actual.serverEnvironment, configValueAtom: () => noConfig },
  };
});

import { SecretRequestCard } from "./SecretRequestCard";

const environmentId = EnvironmentId.make("env");
const now = DateTime.makeUnsafe("2026-11-01T00:00:00.000Z");
const item: SecretRequestItem = {
  type: "secret_request",
  id: TurnItemId.make("secret-item"),
  threadId: ThreadId.make("thread"),
  runId: null,
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: 0,
  status: "running",
  title: null,
  startedAt: now,
  completedAt: null,
  updatedAt: now,
  label: "Demo login",
  reason: "",
  delivery: "file",
  fields: [
    { name: "username", label: "Username", secret: false },
    { name: "password", label: "Password" },
  ],
  secretStatus: "pending",
};
const card = <SecretRequestCard environmentId={environmentId} item={item} visibility="local" />;

it("keeps typed values across a remount and drops them once saved", async () => {
  state.answer.mockResolvedValue(AsyncResult.success(undefined));
  await using screen = await render(card);
  await screen.getByLabelText("Username").fill("demo-user");
  await screen.getByLabelText("Password", { exact: true }).fill("hunter2");

  // Switching threads unmounts the timeline row.
  await screen.rerender(null);
  await screen.rerender(card);
  await expect.element(screen.getByLabelText("Username")).toHaveValue("demo-user");
  await expect.element(screen.getByLabelText("Password", { exact: true })).toHaveValue("hunter2");

  await screen.getByRole("button", { name: "Save securely" }).click();
  // Decline is disabled until the answer settles.
  await expect.element(screen.getByRole("button", { name: "Decline" })).toBeEnabled();
  expect(state.answer).toHaveBeenCalledOnce();
  await screen.rerender(null);
  await screen.rerender(card);
  await expect.element(screen.getByLabelText("Username")).toHaveValue("");
});
