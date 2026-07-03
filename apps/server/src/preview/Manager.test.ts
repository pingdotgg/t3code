import { createServer } from "node:http";

import { describe, expect, it } from "vitest";
import { Effect } from "effect";

import { PreviewInvalidUrlError, PreviewSessionLookupError, ThreadId } from "@t3tools/contracts";
import { PreviewManager, PreviewManagerLive } from "./Manager.ts";

const runPreviewEffect = <A, E>(effect: Effect.Effect<A, E, PreviewManager>) =>
  Effect.runPromise(effect.pipe(Effect.provide(PreviewManagerLive)));

describe("PreviewManager", () => {
  it("opens, lists, resizes, reports and closes preview sessions", async () => {
    const result = await runPreviewEffect(
      Effect.gen(function* () {
        const manager = yield* PreviewManager;
        const threadId = ThreadId.make("thread-preview");
        const opened = yield* manager.open({ threadId, url: "localhost:3000" });
        const listed = yield* manager.list({ threadId });
        const resized = yield* manager.resize({
          threadId,
          tabId: opened.tabId,
          viewport: { _tag: "freeform", width: 390, height: 844 },
        });
        yield* manager.reportStatus({
          threadId,
          tabId: opened.tabId,
          navStatus: {
            _tag: "Success",
            url: "http://localhost:3000/",
            title: "App",
          },
          canGoBack: true,
          canGoForward: false,
        });
        const afterReport = yield* manager.list({ threadId });
        yield* manager.close({ threadId, tabId: opened.tabId });
        const afterClose = yield* manager.list({ threadId });

        return { opened, listed, resized, afterReport, afterClose };
      }),
    );

    expect(result.opened.navStatus).toMatchObject({
      _tag: "Loading",
      url: "http://localhost:3000/",
    });
    expect(result.listed.sessions).toHaveLength(1);
    expect(result.resized.viewport).toEqual({ _tag: "freeform", width: 390, height: 844 });
    expect(result.afterReport.sessions[0]?.navStatus).toMatchObject({
      _tag: "Success",
      title: "App",
    });
    expect(result.afterReport.sessions[0]?.canGoBack).toBe(true);
    expect(result.afterClose.sessions).toHaveLength(0);
  });

  it("rejects unsupported protocols and unknown sessions", async () => {
    await expect(
      runPreviewEffect(
        Effect.gen(function* () {
          const manager = yield* PreviewManager;
          yield* manager.open({
            threadId: ThreadId.make("thread-preview"),
            url: "file:///tmp/app",
          });
        }),
      ),
    ).rejects.toBeInstanceOf(PreviewInvalidUrlError);

    await expect(
      runPreviewEffect(
        Effect.gen(function* () {
          const manager = yield* PreviewManager;
          yield* manager.resize({
            threadId: ThreadId.make("thread-preview"),
            tabId: "missing",
            viewport: { _tag: "fill" },
          });
        }),
      ),
    ).rejects.toBeInstanceOf(PreviewSessionLookupError);
  });

  it("persists refresh timestamps in listed sessions", async () => {
    const result = await runPreviewEffect(
      Effect.gen(function* () {
        const manager = yield* PreviewManager;
        const threadId = ThreadId.make("thread-preview");
        const opened = yield* manager.open({ threadId, url: "localhost:3000" });
        yield* Effect.promise(async () => {
          while (new Date().toISOString() === opened.updatedAt) {
            await new Promise((resolve) => setTimeout(resolve, 1));
          }
        });
        yield* manager.refresh({ threadId, tabId: opened.tabId });
        const afterRefresh = yield* manager.list({ threadId });

        return { opened, afterRefresh };
      }),
    );

    expect(result.afterRefresh.sessions[0]?.updatedAt).not.toBe(result.opened.updatedAt);
  });

  it("discovers reachable local development servers", async () => {
    const server = createServer((_request, response) => {
      response.setHeader("content-type", "text/html");
      response.end("<!doctype html><title>Preview App</title><h1>Hello</h1>");
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected local server address.");
    }

    try {
      const result = await runPreviewEffect(
        Effect.gen(function* () {
          const manager = yield* PreviewManager;
          return yield* manager.discoverLocalServers({
            host: "127.0.0.1",
            ports: [address.port],
          });
        }),
      );

      expect(result.servers).toEqual([
        {
          url: `http://127.0.0.1:${address.port}/`,
          host: "127.0.0.1",
          port: address.port,
          title: "Preview App",
          status: 200,
        },
      ]);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    }
  });
});
