import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentId, PreviewTabId, type PreviewAutomationSnapshot } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as PlaywrightPreviewHost from "./PlaywrightPreviewHost.ts";

const noBrowsers = PlaywrightPreviewHost.layer.pipe(
  Layer.provide(FileSystem.layerNoop({ exists: () => Effect.succeed(false) })),
);

const realHost = PlaywrightPreviewHost.layer.pipe(Layer.provide(NodeServices.layer));

const scope = {
  environmentId: EnvironmentId.make("environment-test"),
  providerSessionId: "session-a",
};
const otherScope = { ...scope, providerSessionId: "session-b" };

describe("resolveNavigationUrl", () => {
  it("normalizes urls and builds environment-port targets", () => {
    expect(PlaywrightPreviewHost.resolveNavigationUrl({ url: "t3.chat" })).toBe("https://t3.chat/");
    expect(
      PlaywrightPreviewHost.resolveNavigationUrl({
        target: { kind: "environment-port", port: 5173, path: "settings" },
      }),
    ).toBe("http://localhost:5173/settings");
    expect(PlaywrightPreviewHost.resolveNavigationUrl({ url: "localhost:5173" })).toBe(
      "http://localhost:5173/",
    );
    expect(
      PlaywrightPreviewHost.resolveNavigationUrl({
        target: { kind: "environment-port", port: 5173, path: "/settings?tab=a" },
      }),
    ).toBe("http://localhost:5173/settings?tab=a");
    expect(
      PlaywrightPreviewHost.resolveNavigationUrl({
        target: { kind: "environment-port", port: 8443, protocol: "https" },
      }),
    ).toBe("https://localhost:8443");
  });
});

describe("PlaywrightPreviewHost", () => {
  it("routes only engine tab ids", () => {
    expect(PlaywrightPreviewHost.isEngineTabId("engine-gecko-1")).toBe(true);
    expect(PlaywrightPreviewHost.isEngineTabId("tab-1")).toBe(false);
  });

  it.effect("reports no engines and a matching install command when none are installed", () =>
    Effect.gen(function* () {
      const host = yield* PlaywrightPreviewHost.PlaywrightPreviewHost;
      expect(yield* host.installedEngines).toEqual([]);
      const error = yield* host
        .invoke<never>({ scope, operation: "open", input: { engine: "gecko" } })
        .pipe(Effect.flip);
      expect(error._tag).toBe("PreviewAutomationEngineUnavailableError");
      if (error._tag !== "PreviewAutomationEngineUnavailableError") return;
      expect(error.engine).toBe("gecko");
      expect(error.installCommand).toMatch(/^npx playwright-core@\d+\.\d+\.\d+ install firefox$/);
    }).pipe(Effect.provide(noBrowsers)),
  );

  it.effect("fails on unknown or missing engine tabs without touching a browser", () =>
    Effect.gen(function* () {
      const host = yield* PlaywrightPreviewHost.PlaywrightPreviewHost;
      const closed = yield* host
        .invoke<never>({
          scope,
          operation: "snapshot",
          input: {},
          tabId: PreviewTabId.make("engine-webkit-9"),
        })
        .pipe(Effect.flip);
      expect(closed._tag).toBe("PreviewAutomationEngineError");
      const untargeted = yield* host
        .invoke<never>({ scope, operation: "click", input: {} })
        .pipe(Effect.flip);
      expect(untargeted._tag).toBe("PreviewAutomationEngineError");
    }).pipe(Effect.provide(noBrowsers)),
  );

  it.live(
    "streams frames and takes input for a tab-driven page in each installed engine",
    () =>
      Effect.gen(function* () {
        const host = yield* PlaywrightPreviewHost.PlaywrightPreviewHost;
        for (const engine of yield* host.installedEngines) {
          const view = yield* host.openView({ owner: "view:test", engine });
          const [, tabId, secret] = view.frameUrl
            .slice(PlaywrightPreviewHost.ENGINE_FRAMES_ROUTE_PREFIX.length)
            .split("/");
          expect(tabId).toBe(view.tabId);
          expect(host.frames(view.tabId, "wrong")).toBeUndefined();
          const frames = host.frames(view.tabId, secret ?? "");
          if (frames === undefined) throw new Error("frames missing");

          yield* host.navigateView(
            view.tabId,
            "data:text/html,<title>Frames</title><body style='background:%23f00'>",
          );
          // A static page yields one screencast frame, then the settled 2x shot.
          const [first, settled] = yield* Stream.runCollect(Stream.take(frames, 2));
          expect(Array.from(first?.slice(0, 2) ?? [])).toEqual([0xff, 0xd8]);
          expect(settled).toBeDefined();
          expect(settled?.byteLength).not.toBe(first?.byteLength);

          yield* host.sendInput(view.tabId, { type: "mouseMove", x: 10, y: 10 });
          yield* host.sendInput(view.tabId, { type: "keyDown", key: "a" });
          yield* host.sendInput(view.tabId, { type: "keyUp", key: "a" });
          yield* host.resizeView(view.tabId, { _tag: "freeform", width: 640, height: 480 });

          yield* host.closeView(view.tabId);
          const events = yield* Stream.runCollect(view.events);
          expect(events.at(-1)).toEqual({ type: "closed" });
          expect(events.some((event) => event.type === "status")).toBe(true);
        }
      }).pipe(Effect.provide(realHost)),
    { timeout: 120_000 },
  );

  // Runs against every engine found on this host. Passes without checking
  // anything when none is installed.
  it.live(
    "drives a real headless page in each installed engine",
    () =>
      Effect.gen(function* () {
        const host = yield* PlaywrightPreviewHost.PlaywrightPreviewHost;
        const setHtml =
          "document.body.innerHTML = \"<button id='go' onclick=\\\"document.title='Clicked'\\\">Go</button><input aria-label='Name'>\"";
        for (const engine of yield* host.installedEngines) {
          const opened = yield* host.invoke<{ tabId: string; engine: string }>({
            scope,
            operation: "open",
            input: { engine },
          });
          expect(opened.engine).toBe(engine);
          const tabId = PreviewTabId.make(opened.tabId);
          const reused = yield* host.invoke<{ tabId: string }>({
            scope,
            operation: "open",
            input: { engine },
          });
          expect(reused.tabId).toBe(opened.tabId);
          const foreign = yield* host
            .invoke<never>({ scope: otherScope, operation: "status", input: {}, tabId })
            .pipe(Effect.flip);
          expect(foreign._tag).toBe("PreviewAutomationEngineError");
          yield* host.invoke({
            scope,
            operation: "evaluate",
            input: { expression: setHtml },
            tabId,
          });
          yield* host.invoke({
            scope,
            operation: "click",
            input: { locator: "role=button[name='Go']" },
            tabId,
          });
          yield* host.invoke({
            scope,
            operation: "type",
            input: { locator: "#go ~ input", text: "Ada" },
            tabId,
          });
          const value = yield* host.invoke({
            scope,
            operation: "evaluate",
            input: { expression: "document.querySelector('input').value" },
            tabId,
          });
          expect(value).toBe("Ada");
          const snapshot = yield* host.invoke<PreviewAutomationSnapshot>({
            scope,
            operation: "snapshot",
            input: {},
            tabId,
          });
          expect(snapshot.title).toBe("Clicked");
          expect(snapshot.interactiveElements.map((element) => element.role)).toEqual([
            "button",
            "textbox",
          ]);
          expect(snapshot.screenshot.data.length).toBeGreaterThan(0);
          const recording = yield* host
            .invoke<never>({ scope, operation: "recordingStart", input: {}, tabId })
            .pipe(Effect.flip);
          expect(recording._tag).toBe("PreviewAutomationEngineError");
          const stuck = yield* host
            .invoke<never>({
              scope,
              operation: "evaluate",
              input: { expression: "new Promise(() => {})" },
              tabId,
              timeoutMs: 500,
            })
            .pipe(Effect.flip);
          expect(stuck._tag).toBe("PreviewAutomationEngineError");
          const gone = yield* host
            .invoke<never>({ scope, operation: "status", input: {}, tabId })
            .pipe(Effect.flip);
          expect(gone._tag).toBe("PreviewAutomationEngineError");
        }
      }).pipe(Effect.provide(realHost)),
    { timeout: 120_000 },
  );
});
