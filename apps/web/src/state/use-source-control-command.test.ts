import type { AtomCommand } from "@t3tools/client-runtime/state/runtime";
import {
  AuthOrchestrationOperateScope,
  AuthSourceControlWriteScope,
  EnvironmentAuthorizationError,
  EnvironmentId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import { beforeEach, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  grants: new Map<string, Set<string>>(),
  run: vi.fn(),
}));

vi.mock("react", () => ({ useCallback: (callback: unknown) => callback }));
vi.mock("./session", () => ({
  readEnvironmentScope: (environmentId: string, scope: string) =>
    state.grants.get(environmentId)?.has(scope) === true,
}));
vi.mock("./use-atom-command", () => ({ useAtomCommand: () => state.run }));

import { useSourceControlCommand } from "./use-source-control-command";

const primary = EnvironmentId.make("primary");
const secondary = EnvironmentId.make("secondary");
type Target = { environmentId: EnvironmentId; input: { action: string } };
const command: AtomCommand<Target, string, Error> = {
  label: "pull request mutation",
  run: state.run,
};
const target = (environmentId: EnvironmentId, action = "comment"): Target => ({
  environmentId,
  input: { action },
});

beforeEach(() => {
  state.grants.clear();
  state.run.mockReset().mockResolvedValue(AsyncResult.success("receipt"));
});

it("does not borrow the primary environment's grant for a secondary pull request", async () => {
  state.grants.set(primary, new Set([AuthSourceControlWriteScope]));
  const mutate = useSourceControlCommand(command, { reportFailure: false });

  const result = await mutate(target(secondary));

  expect(result._tag).toBe("Failure");
  if (result._tag === "Failure") {
    expect(Cause.squash(result.cause)).toBeInstanceOf(EnvironmentAuthorizationError);
    expect(Cause.squash(result.cause)).toMatchObject({
      requiredScope: AuthSourceControlWriteScope,
    });
  }
  expect(state.run).not.toHaveBeenCalled();
});

it("allows source control on the target without task or primary-environment permission", async () => {
  state.grants.set(secondary, new Set([AuthSourceControlWriteScope]));

  const result = await useSourceControlCommand(command)(target(secondary));

  expect(result).toMatchObject({ _tag: "Success", value: "receipt" });
  expect(state.run).toHaveBeenCalledWith(target(secondary));
});

it("does not accept task permission in place of source-control permission", async () => {
  state.grants.set(secondary, new Set([AuthOrchestrationOperateScope]));

  expect((await useSourceControlCommand(command)(target(secondary)))._tag).toBe("Failure");
  expect(state.run).not.toHaveBeenCalled();
});

it("blocks a retained menu callback after revocation", async () => {
  state.grants.set(secondary, new Set([AuthSourceControlWriteScope]));
  const mutate = useSourceControlCommand(command);
  state.grants.delete(secondary);

  expect((await mutate(target(secondary, "set-labels")))._tag).toBe("Failure");
  expect(state.run).not.toHaveBeenCalled();
});

it("allows a retained callback after the target gains its grant", async () => {
  const mutate = useSourceControlCommand(command);
  expect((await mutate(target(secondary, "submit-review")))._tag).toBe("Failure");
  state.grants.set(secondary, new Set([AuthSourceControlWriteScope]));

  expect((await mutate(target(secondary, "submit-review")))._tag).toBe("Success");
  expect(state.run).toHaveBeenCalledTimes(1);
});

it.each(["close", "reopen"])(
  "keeps an accepted comment but does not dispatch %s after access changes during posting",
  async (action) => {
    state.grants.set(secondary, new Set([AuthSourceControlWriteScope]));
    const commentReceipt = AsyncResult.success("comment receipt");
    const posted = Promise.withResolvers<typeof commentReceipt>();
    state.run.mockReturnValueOnce(posted.promise);
    const mutate = useSourceControlCommand(command);
    const commentThenAction = async () => {
      const comment = await mutate(target(secondary, "comment"));
      if (comment._tag === "Failure") return { commentPosted: false, action };
      const result = await mutate(target(secondary, action));
      return { commentPosted: true, action: result._tag };
    };

    const pending = commentThenAction();
    state.grants.delete(secondary);
    posted.resolve(commentReceipt);

    expect(await pending).toEqual({ commentPosted: true, action: "Failure" });
    expect(state.run).toHaveBeenCalledExactlyOnceWith(target(secondary, "comment"));
  },
);

it("preserves an allowed host failure for the caller's existing error handling", async () => {
  state.grants.set(secondary, new Set([AuthSourceControlWriteScope]));
  const failure = AsyncResult.failure(Cause.fail(new Error("Branch protection refused the merge")));
  state.run.mockResolvedValue(failure);

  expect(await useSourceControlCommand(command)(target(secondary, "merge"))).toBe(failure);
});
