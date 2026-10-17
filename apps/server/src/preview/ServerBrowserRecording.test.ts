import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import {
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  type PreviewAutomationRecordingArtifact,
  type PreviewAutomationStatus,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { chromium, type Page } from "playwright-core";
import { expect, vi } from "vite-plus/test";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as Broker from "../mcp/PreviewAutomationBroker.ts";
import * as DesktopChannel from "./DesktopBrowserChannel.ts";
import * as Manager from "./Manager.ts";
import * as PreviewBrowser from "./PreviewBrowser.ts";
import * as ServerBrowser from "./ServerBrowser.ts";
import { ServerBrowserContexts } from "./ServerBrowserContexts.ts";

const scope = {
  environmentId: EnvironmentId.make("recording-test-environment"),
  thread: {
    threadId: ThreadId.make("recording-test-thread"),
    providerSessionId: "recording-test-agent",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  requestNamespace: "recording-test",
  capabilities: new Set(["preview"] as const),
  issuedAt: 1,
};

const dependencies = Layer.mergeAll(
  Broker.layer,
  Manager.layer,
  DesktopChannel.layer,
  Layer.succeed(ServerEnvironment.ServerEnvironment, {
    getEnvironmentId: Effect.succeed(scope.environmentId),
    getDescriptor: Effect.die("unused descriptor"),
  }),
  Layer.succeed(PreviewBrowser.PreviewBrowser, {
    // CI installs only the headless shell; executablePath() names full Chrome.
    executable: Effect.acquireUseRelease(
      Effect.promise(() => chromium.launchServer({ headless: true })),
      (server) => Effect.succeed(server.process().spawnfile),
      (server) => Effect.promise(() => server.close()),
    ),
    installed: Effect.die("the test uses Playwright's installed browser"),
  }),
).pipe(
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-recording-test-" })),
  Layer.provideMerge(NodeServices.layer),
);
const layer = ServerBrowser.layer.pipe(Layer.provideMerge(dependencies));

it.live(
  "headless agent recordings use the latest explicit client rate for each new recording",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        // Observe the real browser encoder without substituting capture or MediaRecorder.
        const encoders: Page[] = [];
        const scratchPage = ServerBrowserContexts.prototype.scratchPage;
        const observer = vi
          .spyOn(ServerBrowserContexts.prototype, "scratchPage")
          .mockImplementation(async function (this: ServerBrowserContexts) {
            const page = await scratchPage.call(this);
            await page.evaluate(`(() => {
            const Recorder = window.MediaRecorder;
            window.MediaRecorder = class extends Recorder {
              constructor(stream, options) {
                super(stream, options);
                window.__recordingConfiguration = {
                  frameRate: stream.getVideoTracks()[0].getSettings().frameRate,
                  bitsPerSecond: this.videoBitsPerSecond,
                };
              }
            };
          })()`);
            encoders.push(page);
            return page;
          });
        yield* Effect.addFinalizer(() => Effect.sync(() => observer.mockRestore()));
        const browser = yield* ServerBrowser.ServerBrowser;
        const broker = yield* Broker.PreviewAutomationBroker;
        const fs = yield* FileSystem.FileSystem;
        yield* Effect.yieldNow;
        // No desktop, UI client, or stream viewer participates in this recording path.
        const opened = yield* broker.invoke<PreviewAutomationStatus>({
          scope,
          operation: "open",
          input: { reuseExistingTab: false, show: false },
        });
        const tabId = opened.tabId!;
        yield* broker.invoke({
          scope,
          tabId,
          operation: "resize",
          input: { mode: "freeform", width: 800, height: 450 },
        });
        const start = broker.invoke({ scope, tabId, operation: "recordingStart", input: {} });
        const stop = broker
          .invoke<PreviewAutomationRecordingArtifact>({
            scope,
            tabId,
            operation: "recordingStop",
            input: {},
          })
          .pipe(
            Effect.flatMap((artifact) =>
              fs.readFile(artifact.path).pipe(
                Effect.tap((bytes) =>
                  Effect.sync(() => {
                    expect(bytes.byteLength).toBe(artifact.sizeBytes);
                    expect(bytes.byteLength).toBeGreaterThan(0);
                  }),
                ),
              ),
            ),
          );
        const configuration = () =>
          Effect.promise(() =>
            encoders
              .at(-1)!
              .evaluate<{ frameRate: number; bitsPerSecond: number }>(
                "window.__recordingConfiguration",
              ),
          );
        const profiles = { profiles: [], defaultProfileId: "default" };

        yield* start;
        expect(yield* configuration()).toEqual({ frameRate: 30, bitsPerSecond: 2_500_000 });
        yield* stop;

        yield* browser.reportProfiles({ ...profiles, recordingFrameRate: 60 });
        // A report from an older client must not silently reset the explicit preference.
        yield* browser.reportProfiles(profiles);
        yield* start;
        expect(yield* configuration()).toEqual({ frameRate: 60, bitsPerSecond: 4_320_000 });
        // A settings edit applies to the next recording; a repeated start is idempotent.
        yield* browser.reportProfiles({ ...profiles, recordingFrameRate: 30 });
        yield* start;
        expect(encoders).toHaveLength(2);
        expect((yield* configuration()).frameRate).toBe(60);
        yield* stop;

        yield* start;
        expect(yield* configuration()).toEqual({ frameRate: 30, bitsPerSecond: 2_500_000 });
        yield* stop;
      }),
    ).pipe(Effect.provide(layer)),
);
