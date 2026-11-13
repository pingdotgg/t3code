import { DeviceHostUnavailableError, EnvironmentId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, render } from "../../../test/render";

const state = vi.hoisted(() => ({ test: vi.fn() }));
function setup() {
  state.test.mockReset();
}

vi.mock(import("../../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: (() => state.test) as never,
}));
vi.mock(import("../../state/session"), async (original) => ({
  ...(await original()),
  readEnvironmentScope: (() => true) as never,
}));

import { useHostConnectionChecks } from "./useHostConnectionChecks";

const environmentId = EnvironmentId.make("environment-1");
const targets = [{ environmentId, label: "This Mac", connected: true }];

function Harness({
  onReady,
}: {
  onReady: (run: ReturnType<typeof useHostConnectionChecks>) => void;
}) {
  onReady(useHostConnectionChecks(targets));
  return null;
}

describe("useHostConnectionChecks", () => {
  it("reports a failed check by its message, without a stack trace", async () => {
    setup();
    state.test.mockResolvedValue(
      AsyncResult.failure(
        Cause.fail(
          new DeviceHostUnavailableError({
            hostId: "mac",
            hostLabel: "Mac mini",
            reason: "SSH connection refused.",
          }),
        ),
      ),
    );
    let checks!: ReturnType<typeof useHostConnectionChecks>;
    await using _screen = await render(<Harness onReady={(next) => (checks = next)} />, {
      router: false, // the hook reads no route state
    });

    const results = await act(() =>
      checks.testConnection({ kind: "ssh", id: "mac", label: "Mac mini", target: "user@mac" }),
    );

    expect(results?.[environmentId]).toEqual({
      status: "failed",
      error: "Mac mini is unavailable: SSH connection refused.",
    });
  });
});
