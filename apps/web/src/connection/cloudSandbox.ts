import {
  ConnectionBlockedError,
  downloadEnvironmentSandboxRecording,
  executeEnvironmentSandboxControl,
  loadEnvironmentSandboxStatus,
  openEnvironmentSandboxPreview,
  recoverEnvironmentSandboxRecording,
} from "@t3tools/client-runtime/connection";
import { createManagedSandboxAtoms } from "@t3tools/client-runtime/state/cloudSandbox";
import {
  createEnvironmentRpcCommand,
  createRuntimeCommand,
} from "@t3tools/client-runtime/state/runtime";
import { WS_METHODS, type EnvironmentId, AuthOrchestrationOperateScope } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { isElectron } from "~/env";
import { useEnvironmentQuery } from "~/state/query";
import { readPreparedConnection, useEnvironmentScope } from "~/state/session";
import { connectionAtomRuntime } from "./runtime";

export const cloudSandboxOperation = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "web:cloud-sandbox:operation",
  tag: WS_METHODS.cloudSandboxControl,
});

export const openSandboxPreview = createRuntimeCommand(connectionAtomRuntime, {
  label: "web:cloud-sandbox:preview",
  execute: Effect.fn("web.cloudSandbox.openPreview")(function* (
    input: {
      environmentId: EnvironmentId;
      url: string;
      local: boolean;
      close?: boolean | undefined;
    },
    registry,
  ) {
    const status = yield* loadEnvironmentSandboxStatus(input.environmentId);
    if (status === null)
      return yield* new ConnectionBlockedError({
        reason: "configuration",
        detail: "This environment has no managed cloud sandbox.",
      });
    const permissionInput = {
      resourceId: status.resourceId,
      operation: {
        _tag: "host",
        port: Number(new URL(input.url).port || 80),
        isPublic: false,
      },
    } as const;
    if (
      !registry.get(
        cloudSandboxOperation.permissionAtom(status.controllerEnvironmentId, permissionInput),
      )
    )
      return yield* new ConnectionBlockedError({
        reason: "configuration",
        detail: "This controller session cannot open external previews.",
      });
    // A locally forwarded port only helps when this machine runs the controller.
    const controllerLocal =
      input.local &&
      readPreparedConnection(status.controllerEnvironmentId)?.target._tag ===
        "PrimaryConnectionTarget";
    return yield* openEnvironmentSandboxPreview(
      input.environmentId,
      input.url,
      controllerLocal ? "local" : "protected",
      input.close === true,
    );
  }),
});

export const cloudSandboxStatusAtom = Atom.family((environmentId: EnvironmentId) =>
  connectionAtomRuntime.atom(
    Stream.fromEffect(
      loadEnvironmentSandboxStatus(environmentId).pipe(
        Effect.tapError((error) => Effect.logWarning("Cloud sandbox status failed", error)),
        Effect.orElseSucceed(() => null),
      ),
    ).pipe(Stream.repeat(Schedule.spaced("30 seconds"))),
  ),
);

const managedSandboxes = createManagedSandboxAtoms(connectionAtomRuntime);
export const managedSandboxesAtom = managedSandboxes.list;
export const deleteManagedSandbox = managedSandboxes.remove;
export const cloudSandboxRecordingAtom = Atom.family((environmentId: EnvironmentId) =>
  connectionAtomRuntime
    .atom(recoverEnvironmentSandboxRecording(environmentId))
    .pipe(Atom.setIdleTTL(0)),
);
const cloudSandboxReadyAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.map(cloudSandboxStatusAtom(environmentId), (result) => {
    const status = AsyncResult.getOrElse(result, () => null);
    return status !== null && status.sandbox.state === "ready"
      ? status.capabilities.desktopStreaming
        ? status
        : null
      : null;
  }),
);
export const cloudSandboxDesktopAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.family((viewMode: "desktop" | "browser") =>
    connectionAtomRuntime
      .atom((get) => {
        const ready = get(cloudSandboxReadyAtom(environmentId));
        return Effect.gen(function* () {
          if (ready === null) return { desktopUrl: null };
          const desktop = yield* executeEnvironmentSandboxControl(environmentId, {
            _tag: "desktop",
            viewMode,
          });
          if (desktop._tag !== "desktop")
            return yield* new ConnectionBlockedError({
              reason: "configuration",
              detail: "Unexpected cloud desktop response.",
            });
          return { desktopUrl: desktop.session.desktopUrl };
        });
      })
      .pipe(Atom.setIdleTTL(0)),
  ),
);

export const downloadRecording = createRuntimeCommand(connectionAtomRuntime, {
  label: "web:cloud-sandbox:download",
  execute: Effect.fn("web.cloudSandbox.downloadRecording")(function* (input: {
    environmentId: EnvironmentId;
    recordingId: import("@t3tools/contracts").ManagedCloudSandboxResourceId;
  }) {
    return yield* downloadEnvironmentSandboxRecording(input.environmentId, input.recordingId);
  }),
});

/**
 * Whether this thread's environment can open its sandbox preview in the user's
 * browser: always true for environments without a managed sandbox, and gated
 * on hosted access plus a ready sandbox otherwise.
 */
export function useCloudPreviewExternalAvailable(environmentId: EnvironmentId): boolean {
  const query = useEnvironmentQuery(cloudSandboxStatusAtom(environmentId));
  const status = query.data ?? null;
  const allowed = useEnvironmentScope(
    status?.controllerEnvironmentId ?? environmentId,
    AuthOrchestrationOperateScope,
  );
  if (status === null) return true;
  return (
    allowed &&
    status.sandbox.state === "ready" &&
    (isElectron || status.capabilities.protectedPortHosting === true)
  );
}
