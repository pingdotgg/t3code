/**
 * Boots the auto-archive janitor against live server services.
 * Feature stays default-off via ServerSettings.autoArchiveSettledAfter = null.
 *
 * Mounted from `makeServerLayer`'s application layer so RuntimeServicesLive
 * already provides settings, snapshots, and orchestration.
 */
import * as Crypto from "effect/Crypto";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { CommandId } from "@t3tools/contracts";

import * as ServerSettings from "../serverSettings.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import * as AutoArchiveJanitor from "./AutoArchiveJanitor.ts";

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const settings = yield* ServerSettings.ServerSettingsService;
    const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
    const orchestration = yield* OrchestrationEngine.OrchestrationEngineService;
    const crypto = yield* Crypto.Crypto;

    const deps: AutoArchiveJanitor.AutoArchiveJanitorDeps = {
      getSettings: settings.getSettings,
      listThreads: snapshots.getShellSnapshot().pipe(
        Effect.map((shell) => shell.threads),
        Effect.orElseSucceed(() => []),
      ),
      archiveThread: (threadId) =>
        Effect.gen(function* () {
          const commandUuid = yield* crypto.randomUUIDv4;
          yield* orchestration
            .dispatch({
              type: "thread.archive",
              commandId: CommandId.make(`auto-archive:${commandUuid}`),
              threadId,
            })
            .pipe(Effect.asVoid);
        }).pipe(
          Effect.orElseSucceed(() => undefined),
          Effect.asVoid,
        ),
    };

    const janitor = yield* AutoArchiveJanitor.make(deps);
    yield* Effect.forkScoped(
      janitor.start.pipe(
        Effect.delay(Duration.seconds(5)),
        Effect.andThen(Effect.logInfo("Auto-archive janitor started")),
        Effect.orElseSucceed(() => undefined),
      ),
    );
  }),
);
