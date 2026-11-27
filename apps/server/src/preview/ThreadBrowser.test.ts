import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ThreadId, type OrchestrationV2ThreadShell } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as PreviewManager from "./Manager.ts";
import * as ThreadBrowser from "./ThreadBrowser.ts";

it.effect("opens a shown server tab no agent controls, only in threads that exist", () =>
  Effect.gen(function* () {
    const threadBrowser = yield* ThreadBrowser.ThreadBrowser;
    const previews = yield* PreviewManager.PreviewManager;
    const url = "https://github.com/login/device";

    const missing = yield* threadBrowser
      .open({ threadId: ThreadId.make("thread-gone"), url })
      .pipe(Effect.flip);
    expect(missing._tag).toBe("ThreadBrowserThreadNotFoundError");
    expect((yield* previews.list({ threadId: ThreadId.make("thread-gone") })).sessions).toEqual([]);

    yield* threadBrowser.open({ threadId: ThreadId.make("thread-1"), url });
    const { sessions } = yield* previews.list({ threadId: ThreadId.make("thread-1") });
    expect(sessions).toHaveLength(1);
    // An automation owner would show the tab as held by an agent and isolate its cookies.
    expect(sessions[0]).not.toHaveProperty("automationOwner");
    expect(sessions[0]).toMatchObject({ runtime: "server", reveal: true });
    expect(sessions[0]?.navStatus).toMatchObject({ _tag: "Loading", url });
  }).pipe(
    Effect.provide(
      ThreadBrowser.layer.pipe(
        Layer.provideMerge(
          Layer.mergeAll(
            PreviewManager.layer.pipe(
              Layer.provide(
                ServerConfig.layerTest(process.cwd(), { prefix: "t3-thread-browser-" }),
              ),
              Layer.provide(NodeCrypto.layer),
              Layer.provide(NodeServices.layer),
            ),
            Layer.mock(ProjectionStore.ProjectionStoreV2)({
              getThreadShell: (threadId) =>
                Effect.succeed(
                  threadId === "thread-1"
                    ? ({ id: threadId, providerInstanceId: "codex" } as OrchestrationV2ThreadShell)
                    : null,
                ),
            }),
          ),
        ),
      ),
    ),
  ),
);
