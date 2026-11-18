import type {
  CbmProjectIndexStatus,
  OptimizerId,
  OptimizerStatus,
  ProjectOptimizerSettings,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as CbmIndexService from "./CbmIndexService.ts";
import * as OptimizerProbeService from "./OptimizerProbeService.ts";
import { isSupportedRtkVersion } from "./RtkRewrite.ts";

import {
  sessionOptimizerAttachmentEntries,
  SessionOptimizerAttachments,
  setSessionOptimizerAttachments,
  clearSessionOptimizerAttachments,
  isCurrentSessionOptimizerAttachments,
  type SessionOptimizerCapabilities,
  type SessionOptimizerAttachmentDescriptor,
} from "@t3tools/provider-core/server/sessionOptimizerAttachments";

function configuredOptimizerIds(settings: ProjectOptimizerSettings): ReadonlyArray<OptimizerId> {
  return [
    ...(settings.rtk ? (["rtk"] satisfies OptimizerId[]) : []),
    ...(settings.headroom ? (["headroom"] satisfies OptimizerId[]) : []),
    ...(settings.cbm ? (["cbm"] satisfies OptimizerId[]) : []),
  ];
}

export function resolveInstallableSessionOptimizers(input: {
  readonly settings: ProjectOptimizerSettings;
  readonly capabilities: SessionOptimizerCapabilities;
  readonly statuses: ReadonlyArray<OptimizerStatus>;
}): {
  readonly configured: ReadonlyArray<OptimizerId>;
  readonly rtk: boolean;
  readonly headroom: boolean;
  readonly cbm: boolean;
} {
  const rtk = input.statuses.find((status) => status.id === "rtk");
  const headroom = input.statuses.find((status) => status.id === "headroom");
  const cbm = input.statuses.find((status) => status.id === "cbm");
  return {
    configured: configuredOptimizerIds(input.settings),
    rtk:
      input.settings.rtk &&
      input.capabilities.rtk &&
      rtk?.installed === true &&
      isSupportedRtkVersion(rtk.version),
    headroom:
      input.settings.headroom &&
      input.capabilities.headroom &&
      headroom?.installed === true &&
      headroom.running === true,
    cbm: input.settings.cbm && input.capabilities.cbm && cbm?.installed === true,
  };
}

const make = Effect.gen(function* () {
  const cbmIndexes = yield* CbmIndexService.CbmIndexService;
  const optimizerProbe = yield* OptimizerProbeService.OptimizerProbeService;
  const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
  const serverSettings = yield* ServerSettings.ServerSettingsService;

  const resolve: SessionOptimizerAttachments["Service"]["resolve"] = Effect.fn(
    "SessionOptimizerAttachments.resolve",
  )(
    function* (input: Parameters<SessionOptimizerAttachments["Service"]["resolve"]>[0]) {
      clearSessionOptimizerAttachments(input.threadId);
      if (input.cwd === null) return undefined;

      const thread = yield* projectionStore.getThread(input.threadId);
      const settings = yield* serverSettings.getSettings;
      const configuredSettings = settings.projectOptimizerOverrides[thread.projectId] ?? {
        rtk: false,
        headroom: false,
        cbm: false,
      };
      const configured = configuredOptimizerIds(configuredSettings);
      const snapshot =
        configured.length === 0 ? undefined : yield* optimizerProbe.getStatus({ refresh: true });
      const installable = resolveInstallableSessionOptimizers({
        settings: configuredSettings,
        capabilities: input.capabilities,
        statuses: snapshot?.optimizers ?? [],
      });
      const rtkAttached = installable.rtk;
      const headroom =
        installable.headroom && input.resolveHeadroom !== undefined
          ? yield* input.resolveHeadroom(settings.headroomProxyUrl, settings.cpa.url)
          : undefined;
      const cbmAttached = installable.cbm;
      const cbmCompletion = cbmAttached ? yield* Deferred.make<CbmProjectIndexStatus>() : undefined;
      const cbmAttachment =
        cbmCompletion === undefined
          ? {}
          : {
              cbm: {
                command: settings.optimizerBinaryPaths.cbm,
                args: [],
                env: { CBM_ALLOWED_ROOT: input.cwd },
              },
              cbmIndexCompletion: Deferred.await(cbmCompletion),
            };
      const descriptor: SessionOptimizerAttachmentDescriptor = {
        projectId: thread.projectId,
        cwd: input.cwd,
        configured,
        attached: [
          ...(rtkAttached ? (["rtk"] satisfies OptimizerId[]) : []),
          ...(headroom === undefined ? [] : (["headroom"] satisfies OptimizerId[])),
          ...(cbmAttached ? (["cbm"] satisfies OptimizerId[]) : []),
        ],
        ready: [
          ...(rtkAttached ? (["rtk"] satisfies OptimizerId[]) : []),
          ...(headroom === undefined ? [] : (["headroom"] satisfies OptimizerId[])),
        ],
        ...(rtkAttached ? { rtk: { command: "rtk" } } : {}),
        ...(headroom === undefined ? {} : { headroom }),
        ...cbmAttachment,
      };
      setSessionOptimizerAttachments(input.threadId, descriptor);
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          if (isCurrentSessionOptimizerAttachments(input.threadId, descriptor)) {
            clearSessionOptimizerAttachments(input.threadId);
          }
        }),
      );
      if (cbmCompletion !== undefined) {
        yield* cbmIndexes.ensureIndexed({ projectId: thread.projectId, cwd: input.cwd }).pipe(
          Effect.flatMap((status) => Deferred.succeed(cbmCompletion, status)),
          Effect.orDie,
          Effect.forkDetach,
        );
      }
      return descriptor;
    },
    (effect, input) =>
      effect.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Could not resolve optimizer attachments for provider session.", {
            threadId: input.threadId,
            cause,
          }).pipe(Effect.as(undefined)),
        ),
      ),
  );

  const getStatus: SessionOptimizerAttachments["Service"]["getStatus"] = (input) =>
    optimizerProbe.getStatus(input).pipe(
      Effect.map((snapshot) => ({
        ...snapshot,
        attachments: sessionOptimizerAttachmentEntries().map(([threadId, descriptor]) => {
          const cbmReady = snapshot.cbmIndexes.some(
            (index) =>
              index.projectId === descriptor.projectId &&
              index.repoPath === descriptor.cwd &&
              index.state === "ready",
          );
          return {
            threadId,
            projectId: descriptor.projectId,
            configured: descriptor.configured,
            attached: descriptor.attached,
            ready:
              cbmReady && descriptor.attached.includes("cbm")
                ? Array.from(new Set([...descriptor.ready, "cbm"] satisfies OptimizerId[]))
                : descriptor.ready,
          };
        }),
      })),
    );

  return SessionOptimizerAttachments.of({ resolve, getStatus });
});

export const layer = Layer.effect(SessionOptimizerAttachments, make);
