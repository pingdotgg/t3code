import type { EnvironmentId, ServerSettingsError, ThreadId } from "@t3tools/contracts";
import { resolveDisplayMode } from "@t3tools/shared/displayModes";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as Digest from "effect/crypto/Digest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type * as SqlError from "effect/sql/SqlError";

import * as ServerConfig from "../../config.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as ServerSettings from "../../serverSettings.ts";
import { SHOWN_TAIL_LIMITS, selectShownTail } from "../shownHistory/ShownHistory.ts";
import { type UserViewSelection, userViewTail, userViewText } from "./userViewText.ts";

const FIRST_READ_CORES = 240;
const MAX_READ_CORES = 7_680;

export class UserViewRefused extends Schema.TaggedError<UserViewRefused>()("UserViewRefused", {
  reason: Schema.String,
}) {}

export interface UserViewShape {
  /**
   * The text that the stretch `selection` names of the thread shows the user, ending in the call
   * that shows it again from `environmentId`. `expect` is the sha256 of a view pinned earlier.
   */
  readonly read: (input: {
    readonly threadId: ThreadId;
    readonly environmentId: EnvironmentId;
    readonly selection: UserViewSelection;
    readonly expect?: string | undefined;
  }) => Effect.Effect<
    string,
    UserViewRefused | SqlError.SqlError | Schema.SchemaError | ServerSettingsError
  >;
}

export class UserView extends Context.Service<UserView, UserViewShape>()(
  "t3/fork/userView/UserView",
) {}

export const layer = Layer.effect(
  UserView,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const serverSettings = yield* ServerSettings.ServerSettingsService;
    const { attachmentsDir } = yield* ServerConfig.ServerConfig;
    const digest = yield* Digest.Digest;

    const read: UserViewShape["read"] = Effect.fn("UserView.read")(function* ({
      threadId,
      environmentId,
      selection,
      expect,
    }) {
      const gone = new UserViewRefused({ reason: `thread ${threadId} is no longer available` });
      const [thread] = yield* sql<{ readonly deleted_at: string | null }>`
        SELECT deleted_at FROM orchestration_v2_projection_threads WHERE thread_id = ${threadId}
      `.pipe(NodeSqliteClient.readOnly);
      if (thread === undefined || thread.deleted_at !== null) return yield* gone;
      const mode = resolveDisplayMode(
        (yield* serverSettings.getSettings).threadDisplayModes[threadId],
      );
      if (!mode.subThreads)
        return yield* new UserViewRefused({
          reason:
            "this thread is in Normal, so the user sees the whole timeline; read it with t3_thread_read",
        });
      for (let minCores = FIRST_READ_CORES; ; minCores *= 2) {
        const tail = yield* selectShownTail(
          sql,
          threadId,
          ProjectionStore.inheritedRunFork,
          minCores,
        ).pipe(NodeSqliteClient.readOnly);
        if (tail === null) return yield* gone;
        const result = userViewText({
          threadId,
          environmentId,
          selection,
          expect,
          tail: userViewTail({
            mode,
            rows: tail.rows,
            complete: tail.stop === "start",
            attachmentsDir,
          }),
        });
        if (result.type === "text")
          return result.withSha(
            yield* digest.digestHex(Digest.sha256, new TextEncoder().encode(result.body)),
          );
        if (result.type === "refused") return yield* new UserViewRefused({ reason: result.reason });
        if (tail.stop !== "enough" || minCores >= MAX_READ_CORES)
          return yield* new UserViewRefused({
            reason: `the stretch, or a message it names, is not among the ${
              tail.stop === "cap"
                ? `${SHOWN_TAIL_LIMITS.maxRows.toLocaleString("en-US")} rows or ${SHOWN_TAIL_LIMITS.maxBytes / 1_048_576} MiB of history`
                : `latest ${MAX_READ_CORES.toLocaleString("en-US")} messages`
            } that one view reads; check the id, or read older history with t3_thread_read`,
          });
      }
    });

    return UserView.of({ read });
  }),
);
