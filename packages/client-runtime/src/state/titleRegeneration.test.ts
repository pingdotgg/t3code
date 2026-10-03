import { CommandId, EnvironmentId } from "@t3tools/contracts";
import { Atom, AtomRegistry } from "effect/unstable/reactivity";
import { expect, it } from "vite-plus/test";

import { scopeThreadShell, type EnvironmentThreadShell } from "./models.ts";
import { v2Now, v2ThreadShell } from "./orchestrationV2TestFixtures.ts";
import { waitForTitleRegenerationFailure } from "./titleRegeneration.ts";

const environmentId = EnvironmentId.make("env-title");
const requestId = CommandId.make("regenerate-title");
const otherRequestId = CommandId.make("older-request");

const inFlight = scopeThreadShell(environmentId, {
  ...v2ThreadShell,
  titleRegeneration: { requestId, startedAt: v2Now },
});
const settled = scopeThreadShell(environmentId, { ...v2ThreadShell, titleRegeneration: null });
const failed = scopeThreadShell(environmentId, {
  ...v2ThreadShell,
  titleRegeneration: null,
  titleRegenerationFailure: { requestId, message: "refresh_token_reused" },
});

function setup(initial: EnvironmentThreadShell | null) {
  const atom = Atom.make<EnvironmentThreadShell | null>(initial);
  const registry = AtomRegistry.make();
  const controller = new AbortController();
  const wait = waitForTitleRegenerationFailure({
    registry,
    atom,
    requestId,
    timeoutMs: 60_000,
    signal: controller.signal,
  });
  return {
    wait,
    set: (thread: EnvironmentThreadShell | null) => registry.set(atom, thread),
    abort: () => controller.abort(),
  };
}

it("resolves with the server's reason when the request fails", async () => {
  const { wait, set } = setup(settled);
  set(inFlight);
  set(failed);
  await expect(wait).resolves.toBe("refresh_token_reused");
});

it("reports a failure that settled before the in-flight marker arrived", async () => {
  const { wait } = setup(failed);
  await expect(wait).resolves.toBe("refresh_token_reused");
});

it("sees a success for a request armed after the watcher started", async () => {
  const { wait, set } = setup(settled);
  set(inFlight);
  set(settled);
  await expect(wait).resolves.toBeNull();
});

it("resolves null when the request finishes without failing", async () => {
  const { wait, set } = setup(inFlight);
  set(settled);
  await expect(wait).resolves.toBeNull();
});

it("ignores a failure recorded for another request", async () => {
  const { wait, set } = setup(
    scopeThreadShell(environmentId, {
      ...v2ThreadShell,
      titleRegeneration: { requestId, startedAt: v2Now },
      titleRegenerationFailure: { requestId: otherRequestId, message: "older failure" },
    }),
  );
  set(settled);
  await expect(wait).resolves.toBeNull();
});

it("resolves null when the thread goes away", async () => {
  const { wait, set } = setup(inFlight);
  set(null);
  await expect(wait).resolves.toBeNull();
});

it("resolves null when the watcher is aborted after a rejected command", async () => {
  const { wait, abort } = setup(settled);
  abort();
  await expect(wait).resolves.toBeNull();
});
