import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { describe, expect } from "vite-plus/test";

import * as MirrorBundleTransfer from "./MirrorBundleTransfer.ts";
import * as ServerConfig from "../config.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";

const TestLayer = Layer.effect(
  MirrorBundleTransfer.MirrorBundleTransfer,
  MirrorBundleTransfer.make,
).pipe(
  Layer.provideMerge(ServerSecretStore.layer),
  Layer.provideMerge(NodeSqliteClient.layerMemory()),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-bundle-transfer-test-" })),
  Layer.provideMerge(NodeServices.layer),
);

it.layer(TestLayer)("MirrorBundleTransfer", (it) => {
  describe("upload progress", () => {
    it.effect("tracks cumulative bytes per project and clears on completion", () =>
      Effect.gen(function* () {
        const transfer = yield* MirrorBundleTransfer.MirrorBundleTransfer;

        expect(yield* transfer.uploadProgressForProject("project-a")).toBe(null);

        yield* transfer.trackUpload({
          projectId: "project-a",
          syncId: "sync-1",
          bytes: 1024,
          totalBytes: 4096,
        });
        yield* transfer.trackUpload({
          projectId: "project-a",
          syncId: "sync-1",
          bytes: 2048,
          totalBytes: 4096,
        });

        expect(yield* transfer.uploadProgressForProject("project-a")).toEqual({
          bytes: 2048,
          totalBytes: 4096,
        });
        expect(yield* transfer.uploadProgressForProject("project-b")).toBe(null);

        yield* transfer.clearUpload("sync-1");
        expect(yield* transfer.uploadProgressForProject("project-a")).toBe(null);
      }),
    );
  });
});
