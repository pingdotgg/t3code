import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId } from "@t3tools/contracts";
import { AsyncResult, AtomRegistry } from "effect/unstable/reactivity";

import {
  vcsCommandConcurrency,
  vcsCommandScheduler,
  vcsRemoteRefreshCommandConcurrency,
  vcsRemoteRefreshCommandScheduler,
  vcsStatusRefreshCommandConcurrency,
  vcsStatusRefreshCommandScheduler,
} from "./vcsCommandScheduler.ts";

const target = {
  environmentId: EnvironmentId.make("environment-1"),
  input: { cwd: "/repo" },
};

describe("vcs command scheduling", () => {
  it("does not let a background remote refresh delay a repository mutation", async () => {
    const registry = AtomRegistry.make();
    let releaseRefresh = () => {};
    let markRefreshStarted = () => {};
    const refreshStarted = new Promise<void>((resolve) => {
      markRefreshStarted = resolve;
    });
    const refreshCommand = vcsRemoteRefreshCommandScheduler.schedule(
      registry,
      vcsRemoteRefreshCommandConcurrency,
      target,
      async () => {
        markRefreshStarted();
        await new Promise<void>((resolve) => {
          releaseRefresh = resolve;
        });
        return AsyncResult.success(false);
      },
    );

    await refreshStarted;
    const mutation = await vcsCommandScheduler.schedule(
      registry,
      vcsCommandConcurrency,
      target,
      async () => AsyncResult.success("committed"),
    );

    expect(mutation._tag).toBe("Success");
    if (mutation._tag === "Success") expect(mutation.value).toBe("committed");
    releaseRefresh();
    await refreshCommand;
    registry.dispose();
  });

  it("does not let status polling delay a repository mutation", async () => {
    const registry = AtomRegistry.make();
    let releaseStatus = () => {};
    let markStatusStarted = () => {};
    const statusStarted = new Promise<void>((resolve) => {
      markStatusStarted = resolve;
    });
    const statusCommand = vcsStatusRefreshCommandScheduler.schedule(
      registry,
      vcsStatusRefreshCommandConcurrency,
      target,
      async () => {
        markStatusStarted();
        await new Promise<void>((resolve) => {
          releaseStatus = resolve;
        });
        return AsyncResult.success(undefined);
      },
    );

    await statusStarted;
    const mutation = await vcsCommandScheduler.schedule(
      registry,
      vcsCommandConcurrency,
      target,
      async () => AsyncResult.success("committed"),
    );

    expect(mutation._tag).toBe("Success");
    if (mutation._tag === "Success") expect(mutation.value).toBe("committed");
    releaseStatus();
    await statusCommand;
    registry.dispose();
  });
});
