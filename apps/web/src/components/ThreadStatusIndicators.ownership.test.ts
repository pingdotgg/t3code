import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { Atom, AtomRegistry } from "effect/unstable/reactivity";
import { beforeEach, vi } from "vite-plus/test";

const observations = vi.hoisted(() => ({
  listRefs: vi.fn(),
  query: vi.fn(),
  remoteStatus: vi.fn(),
  status: vi.fn(),
}));

vi.mock("../state/query", () => ({
  useEnvironmentQuery: observations.query,
}));

vi.mock("../state/vcs", () => ({
  vcsEnvironment: {
    listRefs: observations.listRefs,
    remoteStatus: observations.remoteStatus,
    status: observations.status,
  },
}));

import { resolvePassiveRowVcsDemand, usePassiveRowVcsStatus } from "./ThreadStatusIndicators";

const environmentId = EnvironmentId.make("env-1");
const localAtom = Symbol("local-status");

describe("passive row VCS ownership", () => {
  beforeEach(() => {
    observations.listRefs.mockReset();
    observations.query.mockReset();
    observations.remoteStatus.mockReset();
    observations.status.mockReset().mockReturnValue(localAtom);
  });

  it("uses local status only while the row is visible", () => {
    const input = {
      isVisible: true,
      shouldSubscribe: true,
      environmentId,
      cwd: " /repo ",
    };

    expect(resolvePassiveRowVcsDemand(input)).toEqual({
      demand: "local",
      target: { environmentId, input: { cwd: " /repo " } },
    });
    usePassiveRowVcsStatus(input);

    expect(observations.status).toHaveBeenCalledOnce();
    expect(observations.status).toHaveBeenCalledWith({
      environmentId,
      input: { cwd: " /repo " },
    });
    expect(observations.query).toHaveBeenCalledWith(localAtom);
    expect(observations.remoteStatus).not.toHaveBeenCalled();
    expect(observations.listRefs).not.toHaveBeenCalled();
  });

  it.each([
    ["collapsed", false, true, "/repo"],
    ["removed", true, false, "/repo"],
    ["missing cwd", true, true, null],
  ] as const)("releases its query when %s", (_phase, isVisible, shouldSubscribe, cwd) => {
    const input = { isVisible, shouldSubscribe, environmentId, cwd };

    expect(resolvePassiveRowVcsDemand(input)).toBeNull();
    usePassiveRowVcsStatus(input);

    expect(observations.query).toHaveBeenCalledWith(null);
    expect(observations.status).not.toHaveBeenCalled();
    expect(observations.remoteStatus).not.toHaveBeenCalled();
    expect(observations.listRefs).not.toHaveBeenCalled();
  });

  it.effect("finalizes its local subscription when a visible row becomes hidden", () => {
    const registry = AtomRegistry.make();
    let started = 0;
    let finalized = 0;
    let mountedAtom: Atom.Atom<unknown> | null = null;
    let releaseMountedAtom: (() => void) | null = null;
    const localSubscriptionAtom = Atom.make(
      Effect.sync(() => {
        started += 1;
      }).pipe(
        Effect.andThen(Effect.never),
        Effect.ensuring(
          Effect.sync(() => {
            finalized += 1;
          }),
        ),
      ),
    ).pipe(Atom.setIdleTTL(0));

    observations.status.mockReturnValue(localSubscriptionAtom);
    observations.query.mockImplementation((atom: Atom.Atom<unknown> | null) => {
      if (atom !== mountedAtom) {
        releaseMountedAtom?.();
        mountedAtom = atom;
        releaseMountedAtom = atom === null ? null : registry.mount(atom);
      }
      return { data: null, error: null, isPending: false, refresh: vi.fn() };
    });

    return Effect.gen(function* () {
      const input = {
        isVisible: true,
        shouldSubscribe: true,
        environmentId,
        cwd: "/repo",
      };
      usePassiveRowVcsStatus(input);
      yield* Effect.yieldNow;

      expect(started).toBe(1);
      expect(finalized).toBe(0);
      expect(observations.status).toHaveBeenCalledOnce();
      expect(observations.remoteStatus).not.toHaveBeenCalled();
      expect(observations.listRefs).not.toHaveBeenCalled();

      usePassiveRowVcsStatus({ ...input, isVisible: false });
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;

      expect(finalized).toBe(1);
      expect(observations.query).toHaveBeenLastCalledWith(null);
      expect(observations.remoteStatus).not.toHaveBeenCalled();
      expect(observations.listRefs).not.toHaveBeenCalled();
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          releaseMountedAtom?.();
          registry.dispose();
        }),
      ),
    );
  });
});
