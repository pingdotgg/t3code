import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import { expect, it } from "@effect/vitest";
import {
  CanvasDocument,
  type CanvasDocumentEvent,
  type CanvasHostStreamEvent,
  type CanvasNode,
  type Project,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import { resolveAttachmentPathById, threadHtmlRenderAttachmentIds } from "../attachmentStore.ts";
import * as HtmlRender from "../htmlRender/HtmlRender.ts";
import * as PreviewBrowser from "../preview/PreviewBrowser.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as PluginKernel from "../plugins/PluginKernel.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import * as CanvasHostBroker from "./CanvasHostBroker.ts";
import * as CanvasService from "./CanvasService.ts";

const decodeStoredDocument = Schema.decodeUnknownEffect(Schema.fromJsonString(CanvasDocument));
const projectId = ProjectId.make("project-canvas");
const otherProjectId = ProjectId.make("project-other");

const project = (workspaceRoot: string): Project => ({
  id: projectId,
  title: "Canvas",
  workspaceRoot,
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  deletedAt: null,
});

/** A service over the ambient ServerConfig, so two instances can share one state dir. */
const canvasLayer = (
  workspaceRoot = process.cwd(),
  hosts?: Layer.Layer<CanvasHostBroker.CanvasHostBroker>,
) =>
  CanvasService.layer.pipe(
    Layer.provideMerge(hosts ?? CanvasHostBroker.layer),
    Layer.provide(WorkspacePaths.layer),
    Layer.provide(
      Layer.mock(ProjectService.ProjectService)({
        getById: (id) =>
          Effect.succeed(id === projectId ? Option.some(project(workspaceRoot)) : Option.none()),
      }),
    ),
  );

const configLayer = ServerConfig.layerTest(process.cwd(), { prefix: "t3-canvas-test-" }).pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(NodeCrypto.layer),
);

const rect = (id: string, x = 0): CanvasNode => ({
  id,
  type: "rect",
  parentId: null,
  x,
  y: 0,
  width: 10,
  height: 10,
});

const imageUrl = "data:image/png;base64,iVBORw0KGgo=";

const withCanvas = <A, E>(effect: Effect.Effect<A, E, CanvasService.CanvasService>) =>
  effect.pipe(Effect.provide(canvasLayer().pipe(Layer.provideMerge(configLayer))));

it.effect("applies batches in order, bumps the revision, and fans out to subscribers", () =>
  withCanvas(
    Effect.gen(function* () {
      const canvas = yield* CanvasService.CanvasService;
      const { document } = yield* canvas.create({ projectId, name: "Board" });
      expect(document.revision).toBe(0);

      const events = yield* Queue.unbounded<CanvasDocumentEvent>();
      yield* canvas.subscribe({ documentId: document.id }).pipe(
        Stream.runForEach((event) => Queue.offer(events, event)),
        Effect.forkScoped,
      );
      const snapshot = yield* Queue.take(events);
      expect(snapshot.type).toBe("snapshot");

      const first = yield* canvas.applyOps({
        documentId: document.id,
        ops: [{ op: "insert", node: rect("a") }],
        clientBatchId: "batch-1",
      });
      const second = yield* canvas.applyOps({
        documentId: document.id,
        ops: [{ op: "update", id: "a", patch: { x: 42 } }],
      });
      expect([first.revision, second.revision]).toEqual([1, 2]);

      const opsEvent = yield* Queue.take(events);
      expect(opsEvent).toMatchObject({ type: "ops", revision: 1, clientBatchId: "batch-1" });
      const updateEvent = yield* Queue.take(events);
      expect(updateEvent).toMatchObject({ type: "ops", revision: 2 });
      expect("clientBatchId" in updateEvent).toBe(false);

      const current = yield* canvas.get({ documentId: document.id });
      expect(current.revision).toBe(2);
      expect(current.rootIds).toEqual(["a"]);
      expect(current.nodes.a?.x).toBe(42);
    }).pipe(Effect.scoped),
  ),
);

it.effect("rejects invalid batches atomically", () =>
  withCanvas(
    Effect.gen(function* () {
      const canvas = yield* CanvasService.CanvasService;
      const { document } = yield* canvas.create({ projectId });
      yield* canvas.applyOps({ documentId: document.id, ops: [{ op: "insert", node: rect("a") }] });

      const unknownNode = yield* canvas
        .applyOps({
          documentId: document.id,
          ops: [
            { op: "insert", node: rect("b") },
            { op: "update", id: "missing", patch: { x: 1 } },
          ],
        })
        .pipe(Effect.flip);
      expect(unknownNode._tag).toBe("CanvasOpRejectedError");

      const malformed = yield* canvas
        .applyOps({ documentId: document.id, ops: [{ op: "update", id: "a", patch: { x: "1" } }] })
        .pipe(Effect.flip);
      expect(malformed._tag).toBe("CanvasOpRejectedError");

      const stale = yield* canvas
        .applyOps({
          documentId: document.id,
          baseRevision: 0,
          ops: [{ op: "delete", id: "a" }],
        })
        .pipe(Effect.flip);
      expect(stale._tag).toBe("CanvasRevisionConflictError");

      const current = yield* canvas.get({ documentId: document.id });
      expect(current.revision).toBe(1);
      expect(Object.keys(current.nodes)).toEqual(["a"]);
      expect(current.nodes.a?.x).toBe(0);
    }),
  ),
);

it.effect("persists pending edits on shutdown and reloads them in a new instance", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const config = yield* ServerConfig.ServerConfig;

    // Closing the layer's scope runs the shutdown flush before the debounce fires.
    const documentId = yield* Effect.gen(function* () {
      const canvas = yield* CanvasService.CanvasService;
      const { document } = yield* canvas.create({ projectId, name: "Persisted" });
      yield* canvas.applyOps({
        documentId: document.id,
        ops: [
          { op: "insert", node: rect("a", 5) },
          { op: "rename", name: "Renamed" },
          { op: "put-asset", asset: { id: "img", mimeType: "image/png", url: imageUrl } },
        ],
      });
      return document.id;
    }).pipe(Effect.provide(canvasLayer()));

    const filePath = path.join(config.stateDir, "canvas", projectId, `${documentId}.json`);
    const storedJson = yield* fs.readFileString(filePath);
    const stored = yield* decodeStoredDocument(storedJson);
    expect(stored.revision).toBe(1);
    expect(stored.name).toBe("Renamed");
    // Asset data lives in its own content-addressed file, not in the document.
    expect(storedJson).not.toContain(imageUrl);
    const assetFiles = yield* fs.readDirectory(
      path.join(config.stateDir, "canvas", projectId, `${documentId}.assets`),
    );
    expect(assetFiles).toHaveLength(1);

    const reloaded = yield* Effect.gen(function* () {
      const canvas = yield* CanvasService.CanvasService;
      const summaries = yield* canvas.list({ projectId });
      const document = yield* canvas.get({ documentId });
      return { summaries, document };
    }).pipe(Effect.provide(canvasLayer()));
    expect(reloaded.document.nodes.a?.x).toBe(5);
    expect(reloaded.document.assets.img?.url).toBe(imageUrl);
    expect(reloaded.summaries).toEqual([
      expect.objectContaining({ id: documentId, name: "Renamed", revision: 1, nodeCount: 1 }),
    ]);
  }).pipe(Effect.provide(configLayer)),
);

it.effect("scopes documents to their project and ends subscriptions on delete", () =>
  withCanvas(
    Effect.gen(function* () {
      const canvas = yield* CanvasService.CanvasService;
      const missingProject = yield* canvas.list({ projectId: otherProjectId }).pipe(Effect.flip);
      expect(missingProject._tag).toBe("CanvasProjectNotFoundError");

      const { document } = yield* canvas.create({ projectId });
      const crossProject = yield* canvas
        .get({ documentId: document.id, projectId: otherProjectId })
        .pipe(Effect.flip);
      expect(crossProject._tag).toBe("CanvasDocumentNotFoundError");
      const traversal = yield* canvas.get({ documentId: "../escape" }).pipe(Effect.flip);
      expect(traversal._tag).toBe("CanvasDocumentNotFoundError");

      const events = yield* Queue.unbounded<CanvasDocumentEvent>();
      const subscriber = yield* canvas.subscribe({ documentId: document.id }).pipe(
        Stream.runForEach((event) => Queue.offer(events, event)),
        Effect.forkScoped,
      );
      expect((yield* Queue.take(events)).type).toBe("snapshot");
      yield* canvas.delete({ documentId: document.id });
      expect((yield* Queue.take(events)).type).toBe("deleted");
      // The stream completes on its own after `deleted`.
      expect(Exit.isSuccess(yield* Fiber.await(subscriber))).toBe(true);
      const gone = yield* canvas.get({ documentId: document.id }).pipe(Effect.flip);
      expect(gone._tag).toBe("CanvasDocumentNotFoundError");
    }).pipe(Effect.scoped),
  ),
);

it.effect(
  "ends canvas hosts and subscriptions and persists edits before reenabling the plugin",
  () =>
    Effect.gen(function* () {
      const canvas = yield* CanvasService.CanvasService;
      const hosts = yield* CanvasHostBroker.CanvasHostBroker;
      const kernel = yield* PluginKernel.PluginKernel;
      const { document } = yield* canvas.create({ projectId });
      const events = yield* Queue.unbounded<CanvasDocumentEvent>();
      const subscriber = yield* canvas.subscribe({ documentId: document.id }).pipe(
        Stream.runForEach((event) => Queue.offer(events, event)),
        Effect.forkScoped,
      );
      expect((yield* Queue.take(events)).type).toBe("snapshot");

      const hostEvents = yield* Queue.unbounded<CanvasHostStreamEvent>();
      const host = yield* hosts.connect({ clientId: "canvas-lifecycle-client" }).pipe(
        Stream.runForEach((event) => Queue.offer(hostEvents, event)),
        Effect.forkScoped,
      );
      const connected = yield* Queue.take(hostEvents);
      if (connected.type !== "connected") throw new Error("Expected canvas host registration");
      yield* hosts.update({
        clientId: "canvas-lifecycle-client",
        connectionId: connected.connectionId,
        focused: true,
        mountedDocumentIds: [document.id],
        threadIds: [],
      });
      const pendingScreenshot = yield* hosts
        .screenshot({ documentId: document.id, scale: 1 })
        .pipe(Effect.forkScoped);
      expect((yield* Queue.take(hostEvents)).type).toBe("request");

      yield* canvas.applyOps({
        documentId: document.id,
        ops: [{ op: "insert", node: rect("a", 5) }],
      });
      expect(yield* Queue.take(events)).toMatchObject({ type: "ops", revision: 1 });

      yield* kernel.setEnabled("t3.canvas", false);
      expect(Exit.isSuccess(yield* Fiber.await(subscriber))).toBe(true);
      expect(Exit.isSuccess(yield* Fiber.await(host))).toBe(true);
      const screenshotFailure = yield* Fiber.join(pendingScreenshot).pipe(Effect.flip);
      expect(screenshotFailure._tag).toBe("CanvasHostUnavailableError");

      yield* kernel.setEnabled("t3.canvas", true);
      const reloaded = yield* canvas.get({ documentId: document.id });
      expect(reloaded.revision).toBe(1);
      expect(reloaded.nodes.a?.x).toBe(5);
      const noOldHost = yield* hosts
        .screenshot({ documentId: document.id, scale: 1 })
        .pipe(Effect.flip);
      expect(noOldHost._tag).toBe("CanvasHostUnavailableError");

      yield* canvas.subscribe({ documentId: document.id }).pipe(
        Stream.runForEach((event) => Queue.offer(events, event)),
        Effect.forkScoped,
      );
      expect(yield* Queue.take(events)).toMatchObject({
        type: "snapshot",
        document: { revision: 1 },
      });
      yield* canvas.applyOps({
        documentId: document.id,
        ops: [{ op: "update", id: "a", patch: { x: 17 } }],
      });
      expect(yield* Queue.take(events)).toMatchObject({ type: "ops", revision: 2 });
      expect((yield* canvas.get({ documentId: document.id })).nodes.a?.x).toBe(17);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        canvasLayer().pipe(Layer.provideMerge(configLayer), Layer.provideMerge(PluginKernel.layer)),
      ),
    ),
);

it.effect("refuses workspace imports outside the project root", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const workspaceRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-canvas-workspace-" });
    const error = yield* Effect.gen(function* () {
      const canvas = yield* CanvasService.CanvasService;
      return yield* canvas
        .createFromWorkspaceFile({ projectId, relativePath: "../outside.pen" })
        .pipe(Effect.flip);
    }).pipe(Effect.provide(canvasLayer(workspaceRoot)));
    expect(error._tag).toBe("CanvasImportError");
  }).pipe(Effect.scoped, Effect.provide(configLayer)),
);

it.effect("fails an import that yields nothing instead of creating an empty canvas", () =>
  withCanvas(
    Effect.gen(function* () {
      const canvas = yield* CanvasService.CanvasService;
      const error = yield* canvas
        .create({
          projectId,
          import: { fileName: "broken.fig", bytesBase64: Buffer.from("junk").toString("base64") },
        })
        .pipe(Effect.flip);
      expect(error._tag).toBe("CanvasImportError");
      expect(yield* canvas.list({ projectId })).toEqual([]);
    }),
  ),
);

it.effect("keeps agent screenshots within 2048 px on the longest side", () => {
  const scales: number[] = [];
  // Paints 20% past the node boxes, like shadows would, so the first try overshoots.
  const hosts = Layer.mock(CanvasHostBroker.CanvasHostBroker)({
    screenshot: ({ scale }) => {
      scales.push(scale);
      return Effect.succeed({
        pngBase64: "",
        width: Math.ceil(12_000 * scale),
        height: Math.ceil(600 * scale),
      });
    },
  });
  return Effect.gen(function* () {
    const canvas = yield* CanvasService.CanvasService;
    const { document } = yield* canvas.create({ projectId });
    yield* canvas.applyOps({
      documentId: document.id,
      ops: [{ op: "insert", node: { ...rect("wide"), width: 10_000, height: 500 } }],
    });
    const shot = yield* canvas.screenshot({ documentId: document.id, scale: 2 });
    expect(shot.width).toBeLessThanOrEqual(2048);
    expect(scales).toHaveLength(2);
  }).pipe(Effect.provide(canvasLayer(process.cwd(), hosts).pipe(Layer.provideMerge(configLayer))));
});

it.effect("stores a project-scoped canvas snapshot that survives later canvas edits", () => {
  const capturedNodes: Array<string | undefined> = [];
  const hosts = Layer.mock(CanvasHostBroker.CanvasHostBroker)({
    screenshot: ({ nodeId }) => {
      capturedNodes.push(nodeId);
      return Effect.succeed({
        pngBase64: imageUrl.slice(imageUrl.indexOf(",") + 1),
        width: 400,
        height: 200,
      });
    },
  });
  return Effect.gen(function* () {
    const canvas = yield* CanvasService.CanvasService;
    const fs = yield* FileSystem.FileSystem;
    const config = yield* ServerConfig.ServerConfig;
    const threadId = ThreadId.make("thread-canvas-render");
    const { document } = yield* canvas.create({ projectId, name: "Board" });
    yield* canvas.applyOps({
      documentId: document.id,
      ops: [{ op: "insert", node: { ...rect("card"), name: "Card" } }],
    });
    const input = { documentId: document.id, projectId, threadId, nodeId: "card" };
    const crossProject = yield* canvas
      .render({ ...input, projectId: otherProjectId })
      .pipe(Effect.flip);
    expect(crossProject._tag).toBe("CanvasDocumentNotFoundError");
    const missingNode = yield* canvas.render({ ...input, nodeId: "missing" }).pipe(Effect.flip);
    expect(missingNode._tag).toBe("CanvasNodeNotFoundError");
    expect(capturedNodes).toEqual([]);

    const reference = yield* canvas.render(input);
    expect(capturedNodes).toEqual(["card"]);
    expect(reference).toMatchObject({ title: "Card", height: 364 });
    const stored = resolveAttachmentPathById({
      attachmentsDir: config.attachmentsDir,
      attachmentId: reference.attachmentId,
    });
    const snapshot = yield* fs.readFileString(stored ?? "");
    const image = snapshot.match(/src="data:image\/png;base64,([^"]+)"/)?.[1];
    expect(Buffer.from(image ?? "", "base64")).toEqual(
      Buffer.from(imageUrl.slice(imageUrl.indexOf(",") + 1), "base64"),
    );
    expect((yield* canvas.get(input)).revision).toBe(1);
    yield* canvas.applyOps({
      documentId: document.id,
      ops: [{ op: "update", id: "card", patch: { name: "Changed", x: 100 } }],
    });
    expect(yield* fs.readFileString(stored ?? "")).toBe(snapshot);
    const output = { htmlRender: reference };
    expect(
      threadHtmlRenderAttachmentIds(threadId, [{ toolName: "canvas_render", output }]),
    ).toEqual([reference.attachmentId]);
    expect(
      threadHtmlRenderAttachmentIds("another-thread", [{ toolName: "canvas_render", output }]),
    ).toEqual([]);
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        canvasLayer(process.cwd(), hosts),
        HtmlRender.layer.pipe(
          Layer.provide(McpProviderSessions.layer),
          Layer.provide(
            Layer.mock(PreviewBrowser.PreviewBrowser)({
              installed: Effect.succeedNone,
            }),
          ),
        ),
      ).pipe(Layer.provideMerge(configLayer)),
    ),
  );
});
