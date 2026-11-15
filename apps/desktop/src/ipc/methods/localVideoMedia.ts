import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

class VideoFolderReadError extends Schema.TaggedError<VideoFolderReadError>()(
  "VideoFolderReadError",
  { cause: Schema.Defect() },
) {}

import { listVideoFolder as listFolder } from "../../media/LocalVideoMedia.ts";
import * as IpcChannels from "../channels.ts";
import { makeIpcMethod } from "../DesktopIpc.ts";

/** Lists a folder's videos and lets the app's scheme play them as backgrounds. */
export const listVideoFolder = makeIpcMethod({
  channel: IpcChannels.LIST_VIDEO_FOLDER_CHANNEL,
  payload: Schema.String,
  result: Schema.Struct({
    folder: Schema.String,
    files: Schema.Array(Schema.String),
    error: Schema.NullOr(Schema.String),
  }),
  handler: Effect.fn("desktop.ipc.localVideoMedia.listFolder")(function* (folder) {
    return yield* Effect.tryPromise({
      try: () => listFolder(folder),
      catch: (cause) => new VideoFolderReadError({ cause }),
    }).pipe(
      Effect.map((listed) => ({ ...listed, error: null })),
      Effect.orElseSucceed(() => ({
        folder,
        files: [],
        error: "Could not read that folder.",
      })),
    );
  }),
});
