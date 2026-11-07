// Browser-only fixture: import through Vite, then call setup with a fresh disposable pairing URL.
// Uses the app's existing onboarding and RPC commands; never starts a provider turn.
import data from "./data.json";
import * as Effect from "effect/Effect";
import { EnvironmentRegistry } from "@t3tools/client-runtime/connection";
import {
  createEnvironmentRpcCommand,
  createRuntimeCommand,
} from "@t3tools/client-runtime/state/runtime";

export async function setup(pairingUrl, pairedEnvironmentId) {
  const { appAtomRegistry } = await import("../../../src/rpc/atomRegistry.ts");
  const { connectionAtomRuntime } = await import("../../../src/connection/runtime.ts");
  const { connectPairing } = await import("../../../src/connection/onboarding.ts");
  const result = pairedEnvironmentId
    ? { _tag: "Success", value: pairedEnvironmentId }
    : await connectPairing.run(appAtomRegistry, { pairingUrl });
  if (result._tag !== "Success") throw new Error("Synthetic remote pairing failed");
  const environmentId = result.value;
  await waitState(environmentId, "connected");
  const project = createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "fixture:project",
    tag: "projects.mutate",
  });
  const thread = createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "fixture:thread",
    tag: "orchestration.dispatchCommand",
  });
  const seeded = await project.run(appAtomRegistry, {
    environmentId,
    input: {
      type: "project.create",
      commandId: "proof-project",
      projectId: data.projectId,
      title: data.projectTitle,
      workspaceRoot: data.workspaceRoot,
      createWorkspaceRootIfMissing: true,
    },
  });
  if (seeded._tag !== "Success") return { error: seeded };
  const stopped = await thread.run(appAtomRegistry, {
    environmentId,
    input: {
      type: "thread.create",
      commandId: "proof-thread",
      threadId: data.threadId,
      projectId: data.projectId,
      title: data.threadTitle,
      modelSelection: { instanceId: "codex", model: "gpt-5.4" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    },
  });
  if (stopped._tag !== "Success") return { error: stopped };
  return { environmentId, threadId: data.threadId, path: `/${environmentId}/${data.threadId}` };
}

export async function state(environmentId) {
  const { appAtomRegistry } = await import("../../../src/rpc/atomRegistry.ts");
  const { connectionAtomRuntime } = await import("../../../src/connection/runtime.ts");
  const command = createRuntimeCommand(connectionAtomRuntime, {
    label: "fixture:connection-retry:state",
    execute: () =>
      Effect.gen(function* () {
        const r = yield* EnvironmentRegistry.EnvironmentRegistry;
        const s = yield* r.state(environmentId);
        return {
          phase: s.phase,
          attempt: s.attempt,
          retryAt: s.retryAt,
          lastFailure: s.lastFailure ? { reason: s.lastFailure.reason } : null,
        };
      }),
  });
  return command.run(appAtomRegistry, undefined);
}

export async function label(environmentId) {
  const { appAtomRegistry } = await import("../../../src/rpc/atomRegistry.ts");
  const { connectionAtomRuntime } = await import("../../../src/connection/runtime.ts");
  const { ConnectionOnboarding } = await import("@t3tools/client-runtime/connection");
  return createRuntimeCommand(connectionAtomRuntime, {
    label: "fixture:label",
    execute: () =>
      Effect.gen(function* () {
        const onboarding = yield* ConnectionOnboarding.ConnectionOnboarding;
        yield* onboarding.updateBearer({
          environmentId,
          label: data.remoteLabel,
          httpBaseUrl: "http://localhost:14274",
        });
      }),
  }).run(appAtomRegistry, undefined);
}

export async function waitState(environmentId, phase, minimumAttempt = 0) {
  const deadline = performance.now() + 45000;
  while (performance.now() < deadline) {
    const result = await state(environmentId);
    if (
      result._tag === "Success" &&
      result.value.phase === phase &&
      result.value.attempt >= minimumAttempt
    )
      return result.value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for real supervisor ${phase}`);
}

export async function stack(environmentId, enabled) {
  const { appAtomRegistry } = await import("../../../src/rpc/atomRegistry.ts");
  const { serverUpdateStateAtom } = await import("@t3tools/client-runtime/state/server");
  appAtomRegistry.set(
    serverUpdateStateAtom(environmentId),
    enabled
      ? {
          status: "failed",
          stage: "downloading",
          fromVersion: "0.1.1",
          targetVersion: "0.1.2",
          message: "Synthetic update fixture: download unavailable.",
        }
      : { status: "idle" },
  );
}

export async function trace(environmentId) {
  const { appAtomRegistry } = await import("../../../src/rpc/atomRegistry.ts");
  const { environmentCatalog } = await import("../../../src/connection/catalog.ts");
  const rows = [];
  const start = performance.now();
  const atom = environmentCatalog.stateAtom(environmentId);
  const stop = appAtomRegistry.subscribe(
    atom,
    () => {
      const result = appAtomRegistry.get(atom);
      if (result._tag === "Success") {
        const s = result.value;
        rows.push({
          ms: Math.round(performance.now() - start),
          phase: s.phase,
          attempt: s.attempt,
          retryAt: s.retryAt,
          reason: s.lastFailure?.reason ?? null,
        });
      }
    },
    { immediate: true },
  );
  return { rows, stop };
}

export async function reset(environmentId) {
  const { appAtomRegistry } = await import("../../../src/rpc/atomRegistry.ts");
  const { environmentCatalog } = await import("../../../src/connection/catalog.ts");
  const result = await environmentCatalog.setEnabled.run(appAtomRegistry, {
    environmentId,
    enabled: true,
  });
  if (result._tag !== "Success") throw new Error("Could not enable synthetic environment");
  location.reload();
}

export const scenarios = {
  backoff: "http://localhost:14275/fail",
  heldAttempt: "http://localhost:14275/hold",
  recover: "http://localhost:14275/pass",
};
