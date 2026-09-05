import type { AtomCommand } from "@t3tools/client-runtime/state/runtime";
import { AuthOrchestrationOperateScope, EnvironmentId } from "@t3tools/contracts";
import { AsyncResult } from "effect/unstable/reactivity";
import { beforeEach, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  allowed: new Set<string>(),
  readScope: vi.fn(),
  run: vi.fn(),
}));

vi.mock("react", () => ({ useCallback: (callback: unknown) => callback }));
vi.mock("./session", () => ({ readEnvironmentScope: state.readScope }));
vi.mock("./use-atom-command", () => ({ useAtomCommand: () => state.run }));

import { useOrchestrationCommand } from "./use-orchestration-command";

const first = EnvironmentId.make("primary");
const second = EnvironmentId.make("secondary");
type Target = { environmentId: EnvironmentId; input: { threadId: string } };
const command: AtomCommand<Target, string, Error> = { label: "thread mutation", run: state.run };
const target = (environmentId: EnvironmentId): Target => ({
  environmentId,
  input: { threadId: "thread-1" },
});

beforeEach(() => {
  state.allowed.clear();
  state.run.mockReset().mockResolvedValue(AsyncResult.success("receipt"));
  state.readScope
    .mockReset()
    .mockImplementation(
      (environmentId, scope) =>
        scope === AuthOrchestrationOperateScope && state.allowed.has(environmentId),
    );
});

it("checks the command's environment instead of borrowing the primary grant", async () => {
  state.allowed.add(first);
  const mutate = useOrchestrationCommand(command, { reportFailure: false });
  expect((await mutate(target(second)))._tag).toBe("Failure");
  expect(state.run).not.toHaveBeenCalled();

  expect(await mutate(target(first))).toMatchObject({ _tag: "Success", value: "receipt" });
  expect(state.run).toHaveBeenCalledWith(target(first));
});

it("a retained callback follows both revocation and a new grant without remounting", async () => {
  state.allowed.add(second);
  const mutate = useOrchestrationCommand(command);
  state.allowed.delete(second);
  expect((await mutate(target(second)))._tag).toBe("Failure");
  expect(state.run).not.toHaveBeenCalled();

  state.allowed.add(second);
  expect((await mutate(target(second)))._tag).toBe("Success");
  expect(state.run).toHaveBeenCalledTimes(1);
});

it("does not dispatch a later mutation after access changes while awaiting a receipt", async () => {
  state.allowed.add(second);
  let finish: (() => void) | undefined;
  state.run.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = () => resolve(AsyncResult.success("first receipt"));
      }),
  );
  const mutate = useOrchestrationCommand(command);
  const pending = mutate(target(second));
  state.allowed.delete(second);
  finish!();
  expect((await pending)._tag).toBe("Success");
  expect((await mutate(target(second)))._tag).toBe("Failure");
  expect(state.run).toHaveBeenCalledTimes(1);
});
