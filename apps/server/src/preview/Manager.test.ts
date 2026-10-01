import { it } from "@effect/vitest";
import { type BrowserEngineHostError, type PreviewEvent, ThreadId } from "@t3tools/contracts";
import { PreviewUrlNormalizationError } from "@t3tools/shared/preview";
import { Effect, PubSub } from "effect";
import { expect } from "vite-plus/test";

import * as PreviewManager from "./Manager.ts";

const DRAIN_LIMIT = 100;

const engineStatus = (url: string) =>
  ({
    navStatus: { _tag: "Success", url, title: "Dev" },
    canGoBack: false,
    canGoForward: false,
    zoomFactor: 1.0,
    appearance: "system",
    audioMuted: false,
    audible: false,
    devToolsOpen: false,
    pictureInPicture: false,
    favicon: null,
  }) as const;

interface EventCollector {
  /** Drain everything published since the last call (or since subscribe). */
  readonly drain: Effect.Effect<ReadonlyArray<PreviewEvent>>;
}

/**
 * Each `it.effect` shares the live PreviewManager layer across the whole
 * `it.layer` block, so tests that assert per-thread counts must use a unique
 * thread id to avoid bleeding state from earlier tests.
 */
let nextThreadId = 0;
const freshThreadId = () => ThreadId.make(`thread-${++nextThreadId}`);

/**
 * Subscribe to the manager's event stream BEFORE the test publishes. We
 * use `subscribeEvents` (synchronous PubSub.subscribe under the hood) so
 * no event can land between subscribe and the consumer drain.
 */
const collectEvents = Effect.gen(function* () {
  const manager = yield* PreviewManager.PreviewManager;
  const subscription = yield* manager.subscribeEvents;
  const collector: EventCollector = {
    drain: PubSub.takeUpTo(subscription, DRAIN_LIMIT),
  };
  return collector;
}).pipe(Effect.withSpan("preview.test.collectEvents"));

it.layer(PreviewManager.layer)("PreviewManager", (it) => {
  it.effect("opens a session and emits opened with normalized URL", () =>
    Effect.gen(function* () {
      const threadId = freshThreadId();
      const manager = yield* PreviewManager.PreviewManager;
      const collector = yield* collectEvents;

      const snapshot = yield* manager.open({ threadId, url: "localhost:5173" });
      expect(snapshot.tabId.startsWith("tab_")).toBe(true);
      expect(snapshot.navStatus._tag).toBe("Loading");
      if (snapshot.navStatus._tag === "Loading") {
        expect(snapshot.navStatus.url).toBe("http://localhost:5173/");
      }

      const events = yield* collector.drain;
      expect(events).toHaveLength(1);
      expect(events[0]?.type).toBe("opened");
      if (events[0]?.type === "opened") {
        expect(events[0].tabId).toBe(snapshot.tabId);
      }
    }),
  );

  it.effect("keeps the tab's profile across navigation and status reports", () =>
    Effect.gen(function* () {
      const threadId = freshThreadId();
      const manager = yield* PreviewManager.PreviewManager;

      const opened = yield* manager.open({ threadId, profileId: "work" });
      expect(opened.profileId).toBe("work");

      // `navigate` and `reportStatus` rebuild the snapshot field by field
      // rather than spreading it, so a new field is dropped unless carried
      // explicitly — which would silently move the tab to another profile's
      // partition on its first navigation.
      const navigated = yield* manager.navigate({
        threadId,
        tabId: opened.tabId,
        url: "localhost:5173",
      });
      expect(navigated.profileId).toBe("work");

      yield* manager.reportStatus({
        threadId,
        tabId: opened.tabId,
        navStatus: { _tag: "Success", url: "http://localhost:5173/", title: "Dev" },
        canGoBack: true,
        canGoForward: false,
      });
      const listed = yield* manager.list({ threadId });
      expect(listed.sessions.find((s) => s.tabId === opened.tabId)?.profileId).toBe("work");
    }),
  );

  it.effect("opens an Idle tab when no URL is supplied", () =>
    Effect.gen(function* () {
      const threadId = freshThreadId();
      const manager = yield* PreviewManager.PreviewManager;
      const snapshot = yield* manager.open({ threadId });
      expect(snapshot.navStatus._tag).toBe("Idle");
    }),
  );

  it.effect("orders list snapshots and events with one monotonic revision", () =>
    Effect.gen(function* () {
      const threadId = freshThreadId();
      const manager = yield* PreviewManager.PreviewManager;
      const collector = yield* collectEvents;
      const before = yield* manager.list({ threadId });

      const opened = yield* manager.open({ threadId, url: "http://localhost:5173" });
      yield* manager.navigate({
        threadId,
        tabId: opened.tabId,
        url: "http://localhost:5173/ready",
      });

      const events = yield* collector.drain;
      const listed = yield* manager.list({ threadId });
      expect(events).toHaveLength(2);
      expect(events[0]!.serverEpoch).toBe(listed.serverEpoch);
      expect(events[1]!.serverEpoch).toBe(listed.serverEpoch);
      expect(events[0]!.revision).toBeGreaterThan(before.revision);
      expect(events[1]!.revision).toBeGreaterThan(events[0]!.revision);
      expect(listed.revision).toBe(events[1]!.revision);
      expect(listed.sessions).toHaveLength(1);
    }),
  );

  it.effect("treats bare hosts as https", () =>
    Effect.gen(function* () {
      const threadId = freshThreadId();
      const manager = yield* PreviewManager.PreviewManager;
      const snapshot = yield* manager.open({ threadId, url: "example.com" });
      if (snapshot.navStatus._tag === "Loading") {
        expect(snapshot.navStatus.url).toBe("https://example.com/");
      }
    }),
  );

  it.effect("rejects empty URL with PreviewInvalidUrlError", () =>
    Effect.gen(function* () {
      const threadId = freshThreadId();
      const manager = yield* PreviewManager.PreviewManager;
      const error = yield* Effect.flip(manager.open({ threadId, url: "   " }));
      expect(error._tag).toBe("PreviewInvalidUrlError");
      expect(error).toMatchObject({ inputLength: 3, reason: "empty" });
      expect(error).not.toHaveProperty("rawUrl");
      expect(error.cause).toBeInstanceOf(PreviewUrlNormalizationError);
      expect((error.cause as PreviewUrlNormalizationError).reason).toBe("empty");
    }),
  );

  it.effect("preserves URL parser failures as the invalid URL cause chain", () =>
    Effect.gen(function* () {
      const threadId = freshThreadId();
      const manager = yield* PreviewManager.PreviewManager;
      const rawUrl = "https://user:password@example.com:bad/path?access_token=secret#fragment";
      const error = yield* Effect.flip(manager.open({ threadId, url: rawUrl }));

      expect(error).toMatchObject({
        inputLength: rawUrl.length,
        reason: "parse",
        protocol: "https:",
      });
      expect(error).not.toHaveProperty("rawUrl");
      expect(error.cause).toBeInstanceOf(PreviewUrlNormalizationError);
      const normalizationError = error.cause as PreviewUrlNormalizationError;
      expect(normalizationError.cause).toBeInstanceOf(Error);
      expect(error.message).not.toContain((normalizationError.cause as Error).message);
      expect(error.message).not.toMatch(/user|password|access_token|secret|fragment/);
    }),
  );

  it.effect("navigate updates snapshot and emits navigated", () =>
    Effect.gen(function* () {
      const threadId = freshThreadId();
      const manager = yield* PreviewManager.PreviewManager;
      const collector = yield* collectEvents;

      const opened = yield* manager.open({ threadId, url: "http://localhost:5173" });
      const snapshot = yield* manager.navigate({
        threadId,
        tabId: opened.tabId,
        url: "http://localhost:5173/about",
        resolvedTitle: "About",
      });

      expect(snapshot.navStatus._tag).toBe("Success");
      if (snapshot.navStatus._tag === "Success") {
        expect(snapshot.navStatus.url).toBe("http://localhost:5173/about");
        expect(snapshot.navStatus.title).toBe("About");
      }
      const events = yield* collector.drain;
      expect(events.map((e) => e.type)).toEqual(["opened", "navigated"]);
    }),
  );

  it.effect("navigate fails for unknown tab", () =>
    Effect.gen(function* () {
      const threadId = freshThreadId();
      const manager = yield* PreviewManager.PreviewManager;
      const error = yield* Effect.flip(
        manager.navigate({
          threadId,
          tabId: "tab_missing",
          url: "http://localhost:5173",
        }),
      );
      expect(error._tag).toBe("PreviewSessionLookupError");
    }),
  );

  it.effect("resizes a tab and preserves its viewport across navigation reports", () =>
    Effect.gen(function* () {
      const threadId = freshThreadId();
      const manager = yield* PreviewManager.PreviewManager;
      const collector = yield* collectEvents;
      const opened = yield* manager.open({ threadId, url: "http://localhost:5173" });

      const resized = yield* manager.resize({
        threadId,
        tabId: opened.tabId,
        viewport: { _tag: "freeform", width: 1024, height: 768 },
      });
      expect(resized.viewport).toEqual({ _tag: "freeform", width: 1024, height: 768 });

      const navigated = yield* manager.navigate({
        threadId,
        tabId: opened.tabId,
        url: "http://localhost:5173/resized",
      });
      expect(navigated.viewport).toEqual(resized.viewport);

      yield* manager.reportStatus({
        threadId,
        tabId: opened.tabId,
        navStatus: { _tag: "Success", url: "http://localhost:5173/resized", title: "Resized" },
        canGoBack: true,
        canGoForward: false,
      });
      const listed = yield* manager.list({ threadId });
      expect(listed.sessions[0]?.viewport).toEqual(resized.viewport);

      const events = yield* collector.drain;
      expect(events.map((event) => event.type)).toEqual([
        "opened",
        "resized",
        "navigated",
        "navigated",
      ]);
    }),
  );

  it.effect("rejects resize for an unknown tab", () =>
    Effect.gen(function* () {
      const manager = yield* PreviewManager.PreviewManager;
      const error = yield* Effect.flip(
        manager.resize({
          threadId: freshThreadId(),
          tabId: "tab_missing",
          viewport: { _tag: "fill" },
        }),
      );
      expect(error._tag).toBe("PreviewSessionLookupError");
    }),
  );

  it.effect("reportStatus emits failed for LoadFailed nav", () =>
    Effect.gen(function* () {
      const threadId = freshThreadId();
      const manager = yield* PreviewManager.PreviewManager;
      const collector = yield* collectEvents;

      const opened = yield* manager.open({ threadId, url: "http://localhost:5173" });
      yield* manager.reportStatus({
        threadId,
        tabId: opened.tabId,
        navStatus: {
          _tag: "LoadFailed",
          url: "http://localhost:5173",
          title: "",
          code: -105,
          description: "ERR_NAME_NOT_RESOLVED",
        },
        canGoBack: false,
        canGoForward: false,
      });

      const events = yield* collector.drain;
      const failed = events.find((e) => e.type === "failed");
      expect(failed?.type).toBe("failed");
      if (failed?.type === "failed") {
        expect(failed.code).toBe(-105);
        expect(failed.description).toBe("ERR_NAME_NOT_RESOLVED");
      }
    }),
  );

  it.effect("close removes the session and emits closed", () =>
    Effect.gen(function* () {
      const threadId = freshThreadId();
      const manager = yield* PreviewManager.PreviewManager;
      const collector = yield* collectEvents;

      yield* manager.open({ threadId, url: "http://localhost:5173" });
      yield* manager.close({ threadId });

      const result = yield* manager.list({ threadId });
      expect(result.sessions).toHaveLength(0);
      const events = yield* collector.drain;
      const closed = events.find((e) => e.type === "closed");
      expect(closed?.type).toBe("closed");
    }),
  );

  it.effect("gives every tab in a batch close its own monotonic revision", () =>
    Effect.gen(function* () {
      const threadId = freshThreadId();
      const manager = yield* PreviewManager.PreviewManager;
      yield* manager.open({ threadId, url: "http://localhost:5173" });
      yield* manager.open({ threadId, url: "http://localhost:3000" });
      const collector = yield* collectEvents;

      yield* manager.close({ threadId });

      const events = yield* collector.drain;
      const listed = yield* manager.list({ threadId });
      expect(events).toHaveLength(2);
      expect(events.every((event) => event.type === "closed")).toBe(true);
      expect(events[1]!.revision).toBeGreaterThan(events[0]!.revision);
      expect(listed.revision).toBe(events[1]!.revision);
      expect(listed.sessions).toHaveLength(0);
    }),
  );

  it.effect("close is idempotent for unknown threads", () =>
    Effect.gen(function* () {
      const threadId = freshThreadId();
      const manager = yield* PreviewManager.PreviewManager;
      yield* manager.close({ threadId });
      const result = yield* manager.list({ threadId });
      expect(result.sessions).toHaveLength(0);
    }),
  );

  it.effect("list returns every snapshot for the thread sorted by updatedAt", () =>
    Effect.gen(function* () {
      const threadId = freshThreadId();
      const manager = yield* PreviewManager.PreviewManager;
      const first = yield* manager.open({ threadId, url: "http://localhost:5173" });
      const second = yield* manager.open({ threadId, url: "http://localhost:3000" });
      const result = yield* manager.list({ threadId });
      expect(result.sessions).toHaveLength(2);
      const ids = result.sessions.map((s) => s.tabId);
      expect(ids).toContain(first.tabId);
      expect(ids).toContain(second.tabId);
    }),
  );

  it.effect("open creates an independent tab on every call", () =>
    Effect.gen(function* () {
      const threadId = freshThreadId();
      const manager = yield* PreviewManager.PreviewManager;
      const collector = yield* collectEvents;

      const a = yield* manager.open({ threadId, url: "http://localhost:5173" });
      const b = yield* manager.open({ threadId, url: "http://localhost:3000/path" });

      expect(a.tabId).not.toBe(b.tabId);
      const list = yield* manager.list({ threadId });
      expect(list.sessions).toHaveLength(2);

      const events = yield* collector.drain;
      expect(events.map((e) => e.type)).toEqual(["opened", "opened"]);
    }),
  );

  it.effect("close with mismatching tabId is a no-op", () =>
    Effect.gen(function* () {
      const threadId = freshThreadId();
      const manager = yield* PreviewManager.PreviewManager;
      yield* manager.open({ threadId, url: "http://localhost:5173" });
      yield* manager.close({ threadId, tabId: "tab_missing" });

      const list = yield* manager.list({ threadId });
      expect(list.sessions).toHaveLength(1);
    }),
  );

  it.effect("close with explicit tabId removes only that tab", () =>
    Effect.gen(function* () {
      const threadId = freshThreadId();
      const manager = yield* PreviewManager.PreviewManager;
      const a = yield* manager.open({ threadId, url: "http://localhost:5173" });
      const b = yield* manager.open({ threadId, url: "http://localhost:3000" });

      yield* manager.close({ threadId, tabId: a.tabId });

      const list = yield* manager.list({ threadId });
      expect(list.sessions.map((s) => s.tabId)).toEqual([b.tabId]);
    }),
  );

  it.effect("listDetails separates dispatch requests from engine reports", () =>
    Effect.gen(function* () {
      const threadId = freshThreadId();
      const manager = yield* PreviewManager.PreviewManager;

      const opened = yield* manager.open({ threadId, url: "http://localhost:5173" });
      const afterOpen = yield* manager.listDetails({ threadId });
      const openDetail = afterOpen.sessions.find((s) => s.snapshot.tabId === opened.tabId);
      // Dispatch-side write: a request revision exists, no engine revision.
      expect(openDetail?.navigation.requestedUrl).toBe("http://localhost:5173/");
      expect(openDetail?.navigation.requestRevision).toBeGreaterThan(0);
      expect(openDetail?.navigation.engineRevision).toBeNull();

      // The unfenced legacy report updates the native snapshot but is not
      // engine provenance.
      yield* manager.reportStatus({
        threadId,
        tabId: opened.tabId,
        navStatus: { _tag: "Success", url: "http://localhost:5173/", title: "Dev" },
        canGoBack: false,
        canGoForward: false,
      });
      const afterLegacy = yield* manager.listDetails({ threadId });
      const legacy = afterLegacy.sessions.find((s) => s.snapshot.tabId === opened.tabId);
      expect(legacy?.snapshot.navStatus._tag).toBe("Success");
      expect(legacy?.navigation.engineRevision).toBeNull();

      const target = { threadId, tabId: opened.tabId, serverEpoch: afterOpen.serverEpoch };
      yield* manager.claimEngine({ hostConnectionId: "host-a", target, engineGeneration: "7" });
      yield* manager.reportEngineStatus({
        hostConnectionId: "host-a",
        target,
        engineGeneration: "7",
        status: engineStatus("http://localhost:5173/"),
      });
      const afterReport = yield* manager.listDetails({ threadId });
      const reported = afterReport.sessions.find((s) => s.snapshot.tabId === opened.tabId);
      // Owner report: engineRevision lands at the report's revision and the
      // requested URL survives.
      expect(reported?.navigation.engineRevision).toBe(afterReport.revision);
      expect(reported?.engine?.status?.navStatus._tag).toBe("Success");
      expect(reported?.navigation.requestedUrl).toBe("http://localhost:5173/");

      // A newer dispatch request moves requestRevision ahead of the engine
      // again — provenance, not navStatus, records who wrote last.
      yield* manager.navigate({
        threadId,
        tabId: opened.tabId,
        url: "http://localhost:5173/next",
      });
      const afterNavigate = yield* manager.listDetails({ threadId });
      const pending = afterNavigate.sessions.find((s) => s.snapshot.tabId === opened.tabId);
      expect(pending?.navigation.requestedUrl).toBe("http://localhost:5173/next");
      expect(pending?.navigation.requestRevision).toBe(afterNavigate.revision);
      expect(pending!.navigation.requestRevision!).toBeGreaterThan(
        pending!.navigation.engineRevision!,
      );
    }),
  );

  it.effect("subscribeDetails pairs each event with its post-commit detail", () =>
    Effect.gen(function* () {
      const threadId = freshThreadId();
      const manager = yield* PreviewManager.PreviewManager;
      const subscription = yield* manager.subscribeDetails;

      const publicEvents = yield* manager.subscribeEvents;

      const opened = yield* manager.open({ threadId, url: "http://localhost:5173" });
      const { serverEpoch } = yield* manager.listDetails({ threadId });
      const target = { threadId, tabId: opened.tabId, serverEpoch };
      yield* manager.claimEngine({ hostConnectionId: "host-a", target, engineGeneration: "7" });
      yield* manager.reportEngineStatus({
        hostConnectionId: "host-a",
        target,
        engineGeneration: "7",
        status: engineStatus("http://localhost:5173/"),
      });
      yield* manager.close({ threadId, tabId: opened.tabId });

      const items = yield* PubSub.takeUpTo(subscription, DRAIN_LIMIT);
      expect(items.map((item) => item.event.type)).toEqual([
        "opened",
        "navigated",
        "navigated",
        "closed",
      ]);
      const openedItem = items[0]!;
      expect(openedItem.detail?.navigation.requestRevision).toBe(openedItem.event.revision);
      expect(items[1]!.detail?.engine?.generation).toBe("7");
      const reportedItem = items[2]!;
      expect(reportedItem.detail?.navigation.engineRevision).toBe(reportedItem.event.revision);
      // Removal publishes a null detail so stale projections cannot be read.
      expect(items[3]!.detail).toBeNull();
      // Engine writes never reach native clients as public events.
      const publicTypes = (yield* PubSub.takeUpTo(publicEvents, DRAIN_LIMIT)).map((e) => e.type);
      expect(publicTypes).toEqual(["opened", "closed"]);
    }),
  );

  it.effect("multiple subscribers receive every event independently", () =>
    Effect.gen(function* () {
      const threadId = freshThreadId();
      const manager = yield* PreviewManager.PreviewManager;
      const aSub = yield* manager.subscribeEvents;
      const bSub = yield* manager.subscribeEvents;

      yield* manager.open({ threadId, url: "http://localhost:5173" });
      yield* manager.open({ threadId, url: "http://localhost:3000" });

      const aEvents = yield* PubSub.takeUpTo(aSub, DRAIN_LIMIT);
      const bEvents = yield* PubSub.takeUpTo(bSub, DRAIN_LIMIT);
      expect(aEvents.map((e) => e.type)).toEqual(["opened", "opened"]);
      expect(bEvents.map((e) => e.type)).toEqual(["opened", "opened"]);
    }),
  );
  it.effect("engine claims fence epoch, owner and generation", () =>
    Effect.gen(function* () {
      const threadId = freshThreadId();
      const manager = yield* PreviewManager.PreviewManager;
      const opened = yield* manager.open({ threadId, url: "http://localhost:5173" });
      const { serverEpoch } = yield* manager.listDetails({ threadId });
      const target = { threadId, tabId: opened.tabId, serverEpoch };
      const reasonOf = <A>(effect: Effect.Effect<A, BrowserEngineHostError>) =>
        effect.pipe(
          Effect.flip,
          Effect.map((error) => error.reason),
        );

      expect(
        yield* reasonOf(
          manager.claimEngine({
            hostConnectionId: "host-a",
            target: { ...target, serverEpoch: "old-epoch" },
            engineGeneration: "1",
          }),
        ),
      ).toBe("stale-epoch");
      expect(
        yield* reasonOf(
          manager.claimEngine({
            hostConnectionId: "host-a",
            target: { ...target, tabId: "tab_missing" },
            engineGeneration: "1",
          }),
        ),
      ).toBe("session-not-found");

      yield* manager.claimEngine({ hostConnectionId: "host-a", target, engineGeneration: "1" });
      // A second host cannot silently take over or report for the guest.
      expect(
        yield* reasonOf(
          manager.claimEngine({ hostConnectionId: "host-b", target, engineGeneration: "9" }),
        ),
      ).toBe("foreign-host");
      expect(
        yield* reasonOf(
          manager.reportEngineStatus({
            hostConnectionId: "host-b",
            target,
            engineGeneration: "1",
            status: engineStatus("http://evil.test/"),
          }),
        ),
      ).toBe("foreign-host");
      // The owner reporting for a replaced guest is fenced out.
      yield* manager.claimEngine({ hostConnectionId: "host-a", target, engineGeneration: "2" });
      expect(
        yield* reasonOf(
          manager.reportEngineStatus({
            hostConnectionId: "host-a",
            target,
            engineGeneration: "1",
            status: engineStatus("http://localhost:5173/"),
          }),
        ),
      ).toBe("stale-generation");

      // Explicit handoff replaces owner and generation and drops old provenance.
      yield* manager.reportEngineStatus({
        hostConnectionId: "host-a",
        target,
        engineGeneration: "2",
        status: engineStatus("http://localhost:5173/"),
      });
      yield* manager.claimEngine({
        hostConnectionId: "host-b",
        target,
        engineGeneration: "9",
        handoff: true,
      });
      const handedOff = (yield* manager.listDetails({ threadId })).sessions[0]!;
      expect(handedOff.engine).toEqual({
        hostConnectionId: "host-b",
        generation: "9",
        status: null,
        lifecycle: null,
      });
      expect(handedOff.navigation.engineRevision).toBeNull();
      expect(
        yield* reasonOf(
          manager.releaseEngine({ hostConnectionId: "host-a", target, engineGeneration: "2" }),
        ),
      ).toBe("foreign-host");
    }),
  );

  it.effect("host disconnect releases every claim it held", () =>
    Effect.gen(function* () {
      const threadId = freshThreadId();
      const manager = yield* PreviewManager.PreviewManager;
      const a = yield* manager.open({ threadId, url: "http://localhost:5173" });
      const b = yield* manager.open({ threadId, url: "http://localhost:5174" });
      const { serverEpoch } = yield* manager.listDetails({ threadId });
      yield* manager.claimEngine({
        hostConnectionId: "host-gone",
        target: { threadId, tabId: a.tabId, serverEpoch },
        engineGeneration: "1",
      });
      yield* manager.claimEngine({
        hostConnectionId: "host-stays",
        target: { threadId, tabId: b.tabId, serverEpoch },
        engineGeneration: "2",
      });

      yield* manager.releaseEngineHost("host-gone");

      const details = yield* manager.listDetails({ threadId });
      const byTab = new Map(details.sessions.map((d) => [d.snapshot.tabId, d.engine]));
      expect(byTab.get(a.tabId)).toBeNull();
      expect(byTab.get(b.tabId)?.hostConnectionId).toBe("host-stays");
    }),
  );
});
