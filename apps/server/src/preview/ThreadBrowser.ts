import type { PreviewError, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as PreviewManager from "./Manager.ts";

export class ThreadBrowserThreadNotFoundError extends Schema.TaggedError<ThreadBrowserThreadNotFoundError>()(
  "ThreadBrowserThreadNotFoundError",
  { threadId: Schema.String },
) {
  override get message(): string {
    return `Thread ${this.threadId} does not exist, so it has no browser to open a page in.`;
  }
}

export class ThreadBrowser extends Context.Service<
  ThreadBrowser,
  {
    /** Opens `url` in a new, shown tab of the thread's browser, as the user opening it would. */
    readonly open: (input: {
      readonly threadId: ThreadId;
      readonly url: string;
    }) => Effect.Effect<
      void,
      ThreadBrowserThreadNotFoundError | ProjectionStore.ProjectionStoreV2Error | PreviewError
    >;
  }
>()("t3/preview/ThreadBrowser") {}

const make = Effect.gen(function* () {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const previews = yield* PreviewManager.PreviewManager;

  const open: ThreadBrowser["Service"]["open"] = Effect.fn("ThreadBrowser.open")(function* (input) {
    if ((yield* projections.getThreadShell(input.threadId)) === null) {
      return yield* new ThreadBrowserThreadNotFoundError({ threadId: input.threadId });
    }
    // A server tab with no automation owner: every client can show it, and no agent holds it.
    yield* previews.open({
      threadId: input.threadId,
      url: input.url,
      runtime: "server",
      reveal: true,
    });
  });

  return ThreadBrowser.of({ open });
});

export const layer = Layer.effect(ThreadBrowser, make);
