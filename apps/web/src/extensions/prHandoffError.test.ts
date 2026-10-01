import { expect, it, vi } from "vite-plus/test";
import { SourceControlProviderError, EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import { nativePrHandoffPrepare } from "./clientProviders";

const run = vi.hoisted(() => vi.fn());
vi.mock("@t3tools/client-runtime/state/runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@t3tools/client-runtime/state/runtime")>()),
  runAtomCommand: run,
}));
vi.mock("../components/ThreadTerminalDrawer", () => ({ terminalThemeFromApp: () => ({}) }));

it.each(["local", "worktree"] as const)(
  "gives the extension handoff the same unprefixed detail as native (%s)",
  async (mode) => {
    const detail =
      "If private, run `glab auth login --hostname gitlab.example --api-host gitlab.example:8443` and retry. Merge request !1 was not found or is inaccessible on gitlab.example.";
    const error = new SourceControlProviderError({
      provider: "gitlab",
      operation: "getChangeRequest",
      cwd: "/repo",
      detail,
    });
    run.mockResolvedValueOnce(AsyncResult.failure(Cause.fail(error)));
    expect(
      await nativePrHandoffPrepare({
        environmentId: EnvironmentId.make("env"),
        cwd: "/repo",
        reference: "1",
        mode,
        threadId: ThreadId.make("thread"),
      }),
    ).toEqual({ ok: false, detail });
    expect(error.message).toContain("Source control provider gitlab failed in getChangeRequest:");
  },
);
