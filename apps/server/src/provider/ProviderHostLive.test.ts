import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { MessageId, ThreadId } from "@t3tools/contracts";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import { resolveAttachmentPathById } from "../attachmentStore.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ProviderHostLive from "./ProviderHostLive.ts";

const layerTest = ProviderHostLive.layer.pipe(
  Layer.provideMerge(ServerSecretStore.layer),
  Layer.provideMerge(
    ServerConfig.layerTest(process.cwd(), { prefix: "t3-provider-host-live-" }).pipe(
      Layer.provideMerge(NodeServices.layer),
      Layer.provideMerge(ServerSettings.layerTest()),
      Layer.provideMerge(
        Layer.mock(BackgroundPolicy.BackgroundPolicy)({
          shouldRunScopeWork: () => Effect.succeed(false),
        }),
      ),
    ),
  ),
);

it.layer(layerTest)("ProviderHostLive", (it) => {
  it.effect("stores provider images as stable thread attachments that asset reads resolve", () =>
    Effect.gen(function* () {
      const host = yield* ProviderHost.ProviderHost;
      const fileSystem = yield* FileSystem.FileSystem;
      const image = {
        threadId: ThreadId.make("thread-host"),
        messageId: MessageId.make("message-host"),
        index: 0,
        mimeType: "image/png",
        bytes: new Uint8Array([1, 2, 3]),
      };
      const first = yield* host.persistImageAttachment(image);
      const second = yield* host.persistImageAttachment(image);
      assert.isNotNull(first);
      assert.deepEqual(second, first);
      const path = resolveAttachmentPathById({
        attachmentsDir: host.paths.attachmentsDir,
        attachmentId: first!.id,
      });
      assert.deepEqual(Array.from(yield* fileSystem.readFile(path!)), [1, 2, 3]);
      assert.isNull(yield* host.persistImageAttachment({ ...image, mimeType: "image/svg+xml" }));
    }),
  );
});
