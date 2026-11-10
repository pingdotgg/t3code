import type { EnvironmentId, ModelSelection, RuntimeMode, ThreadId } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { useLayoutEffect } from "react";
import { expect, it, vi } from "vite-plus/test";

import { act, render } from "../../../test/render";
import { useSideChat } from "./useSideChat";

const mocks = vi.hoisted(() => ({
  calls: [] as Array<{ readonly kind: string; readonly args: unknown }>,
  hook: null as ReturnType<typeof useSideChat> | null,
}));

const record = (kind: string) => async (args: unknown) => {
  mocks.calls.push({ kind, args });
  return { _tag: "Success" as const, value: undefined };
};
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: { readonly name?: string }) => record(String(command?.name)),
}));
vi.mock("../../state/use-orchestration-command", () => ({
  useOrchestrationCommand: (command: { readonly name?: string }) => record(String(command?.name)),
}));
vi.mock("../../state/entities", () => ({
  waitForThreadShell: async () => true,
  readThreadShell: () => ({ runtimeMode: "full-access" }),
}));
vi.mock("../../state/threads", () => ({
  threadEnvironment: {
    forkSideChat: { name: "fork" },
    delete: { name: "delete" },
    setRuntimeMode: { name: "setRuntimeMode" },
    startTurn: { name: "startTurn" },
  },
}));

function Probe(props: {
  readonly threadId: string;
  readonly runtimeMode: RuntimeMode;
  readonly model: string;
}) {
  const hook = useSideChat({
    threadRef: scopeThreadRef("env" as EnvironmentId, props.threadId as ThreadId),
    readSettings: () => ({
      runtimeMode: props.runtimeMode,
      modelSelection: { instanceId: "codex", model: props.model } as ModelSelection,
    }),
    onError: () => {},
  });
  useLayoutEffect(() => {
    mocks.hook = hook;
  });
  return null;
}

it("starts a bound side chat from the thread it was bound in after another thread is shown", async () => {
  mocks.calls = [];
  await using screen = await render(
    <Probe threadId="thread-a" runtimeMode="approval-required" model="model-a" />,
  );
  const send = mocks.hook!.bind();
  await screen.rerender(<Probe threadId="thread-b" runtimeMode="full-access" model="model-b" />);
  expect(await act(() => send("side question"))).toBe(true);
  const fork = mocks.calls.find((call) => call.kind === "fork");
  expect(fork?.args).toMatchObject({ input: { sourceThreadId: "thread-a" } });
  const turn = mocks.calls.find((call) => call.kind === "startTurn");
  expect(turn?.args).toMatchObject({
    input: { runtimeMode: "approval-required", modelSelection: { model: "model-a" } },
  });
});
