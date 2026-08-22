// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId, type ServerSettings } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as ServerSettingsModule from "../serverSettings.ts";
import * as AccountLimitsServiceModule from "./AccountLimitsService.ts";

const asInstanceId = (value: string): ProviderInstanceId => ProviderInstanceId.make(value);
const asDriver = (value: string): ProviderDriverKind => ProviderDriverKind.make(value);

/** A codex app-server notification, shaped after a real transcript line. */
const codexPayload = (usedPercent: number) => ({
  limit_id: "codex",
  limit_name: null,
  primary: { used_percent: usedPercent, window_minutes: 10080, resets_at: 1_786_677_720 },
  secondary: null,
  plan_type: "pro",
});

/** A full Claude usage snapshot (the SDK usage control response). */
const claudeUsagePayload = (fiveHour: number, weekly: number) => ({
  subscription_type: "max",
  rate_limits: {
    five_hour: { utilization: fiveHour, resets_at: "2026-08-08T23:00:00.000Z" },
    seven_day: { utilization: weekly, resets_at: "2026-08-11T17:00:00.000Z" },
  },
});

/** The streamed single-window Claude event. `utilization` is a 0-1 fraction. */
const claudeWindowPayload = (utilization: number) => ({
  type: "rate_limit_event",
  rate_limit_info: {
    status: "allowed_warning",
    rateLimitType: "five_hour",
    utilization,
    resetsAt: 1_786_600_800,
  },
});

/**
 * Every instance the tests ingest for must exist in settings: readSummary
 * evicts rows for deleted instances. Codex homes point at paths that do not
 * exist so the transcript seed can never touch this machine's real
 * ~/.codex/sessions mid-test.
 */
const instanceRoster = (): Partial<ServerSettings> => ({
  providerInstances: {
    [asInstanceId("codex")]: {
      driver: asDriver("codex"),
      config: { homePath: "/nonexistent/t3-test-codex-default" },
    },
    [asInstanceId("codex_a")]: {
      driver: asDriver("codex"),
      config: { homePath: "/nonexistent/t3-test-codex-a" },
    },
    [asInstanceId("codex_b")]: {
      driver: asDriver("codex"),
      config: { homePath: "/nonexistent/t3-test-codex-b" },
    },
    [asInstanceId("claude_main")]: { driver: asDriver("claudeAgent") },
    [asInstanceId("claude_partner")]: { driver: asDriver("claudeAgent") },
  },
});

const makeLayer = (overrides: Partial<ServerSettings> = instanceRoster()) =>
  AccountLimitsServiceModule.layer.pipe(
    Layer.provideMerge(ServerSettingsModule.layerTest(overrides)),
    Layer.provideMerge(
      Layer.fresh(
        ServerConfig.layerTest(process.cwd(), {
          prefix: "t3code-account-limits-test-",
        }),
      ),
    ),
  );

const makeLayerAt = (baseDir: string, overrides: Partial<ServerSettings> = instanceRoster()) =>
  AccountLimitsServiceModule.layer.pipe(
    Layer.provideMerge(ServerSettingsModule.layerTest(overrides)),
    Layer.provideMerge(Layer.fresh(ServerConfig.layerTest(process.cwd(), baseDir))),
  );

it.layer(NodeServices.layer)("account limits service", (it) => {
  it.effect("keeps one snapshot per instance - accounts no longer overwrite each other", () =>
    Effect.gen(function* () {
      const service = yield* AccountLimitsServiceModule.AccountLimitsService;
      yield* service.ingest({
        provider: "codex",
        payload: codexPayload(10),
        createdAt: "2026-08-15T12:00:02.000Z",
        providerInstanceId: asInstanceId("codex_a"),
      });
      // Older than codex_a's event: the per-slot ordering guard must not let
      // one instance's traffic suppress another's - that is the bug.
      yield* service.ingest({
        provider: "codex",
        payload: codexPayload(55),
        createdAt: "2026-08-15T12:00:01.000Z",
        providerInstanceId: asInstanceId("codex_b"),
      });
      const summary = yield* service.readSummary();
      expect(
        summary.snapshots.map((snapshot) => [
          snapshot.instanceId,
          snapshot.windows[0]?.usedPercent,
        ]),
      ).toEqual([
        ["codex_a", 10],
        ["codex_b", 55],
      ]);
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("still guards ordering within one instance", () =>
    Effect.gen(function* () {
      const service = yield* AccountLimitsServiceModule.AccountLimitsService;
      yield* service.ingest({
        provider: "codex",
        payload: codexPayload(20),
        createdAt: "2026-08-15T12:00:02.000Z",
        providerInstanceId: asInstanceId("codex_a"),
      });
      yield* service.ingest({
        provider: "codex",
        payload: codexPayload(90),
        createdAt: "2026-08-15T12:00:01.000Z",
        providerInstanceId: asInstanceId("codex_a"),
      });
      const summary = yield* service.readSummary();
      expect(summary.snapshots.map((snapshot) => snapshot.windows[0]?.usedPercent)).toEqual([20]);
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("events without an instance id flow to the driver's default instance", () =>
    Effect.gen(function* () {
      const service = yield* AccountLimitsServiceModule.AccountLimitsService;
      yield* service.ingest({
        provider: "codex",
        payload: codexPayload(33),
        createdAt: "2026-08-15T12:00:00.000Z",
      });
      const summary = yield* service.readSummary();
      expect(summary.snapshots.map((snapshot) => snapshot.instanceId)).toEqual(["codex"]);
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("claude window events patch their own instance's window set only", () =>
    Effect.gen(function* () {
      const service = yield* AccountLimitsServiceModule.AccountLimitsService;
      yield* service.ingest({
        provider: "claudeAgent",
        payload: claudeUsagePayload(24, 18),
        createdAt: "2026-08-15T12:00:00.000Z",
        providerInstanceId: asInstanceId("claude_main"),
      });
      yield* service.ingest({
        provider: "claudeAgent",
        payload: claudeWindowPayload(0.875),
        createdAt: "2026-08-15T12:00:01.000Z",
        providerInstanceId: asInstanceId("claude_partner"),
      });
      const summary = yield* service.readSummary();
      const main = summary.snapshots.find((snapshot) => snapshot.instanceId === "claude_main");
      const partner = summary.snapshots.find(
        (snapshot) => snapshot.instanceId === "claude_partner",
      );
      // Main keeps its full two-window snapshot untouched; partner's streamed
      // window must not have been patched into main's set.
      expect(main?.windows.map((window) => [window.id, window.usedPercent])).toEqual([
        ["five_hour", 24],
        ["seven_day", 18],
      ]);
      expect(partner?.windows.map((window) => [window.id, window.usedPercent])).toEqual([
        ["five_hour", 87.5],
      ]);
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("v1 cache rows load under the default instance until a write settles them", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const config = yield* ServerConfig.ServerConfig;
      // A row written before instance attribution: no instanceId field. It
      // held "whichever account wrote last", so the default instance is only
      // its least-wrong home, not its identity.
      yield* fileSystem.writeFileString(
        path.join(config.stateDir, "account-limits.json"),
        `[
          {
            "provider": "claude",
            "plan": "max",
            "windows": [
              {
                "id": "five_hour",
                "label": "5h",
                "usedPercent": 62,
                "resetsAt": "2026-08-08T23:00:00.000Z",
                "windowMinutes": 300
              }
            ],
            "asOf": "2026-08-08T22:00:00.000Z",
            "source": "live"
          }
        ]`,
      );
      const service = yield* AccountLimitsServiceModule.AccountLimitsService;
      const summary = yield* service.readSummary();
      expect(summary.snapshots.map((snapshot) => [snapshot.instanceId, snapshot.plan])).toEqual([
        ["claudeAgent", "max"],
      ]);
      // Live data for a DIFFERENT instance of the same provider proves the
      // migrated row may belong to somebody else: it is evicted, not kept
      // as a ghost account beside the real one.
      yield* service.ingest({
        provider: "claudeAgent",
        payload: claudeUsagePayload(10, 5),
        createdAt: "2026-08-15T12:00:00.000Z",
        providerInstanceId: asInstanceId("claude_partner"),
      });
      const after = yield* service.readSummary();
      expect(after.snapshots.map((snapshot) => snapshot.instanceId)).toEqual(["claude_partner"]);
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("instance-keyed rows survive a restart", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3code-account-limits-reload-",
      });
      yield* Effect.gen(function* () {
        const service = yield* AccountLimitsServiceModule.AccountLimitsService;
        yield* service.ingest({
          provider: "codex",
          payload: codexPayload(10),
          createdAt: "2026-08-15T12:00:00.000Z",
          providerInstanceId: asInstanceId("codex_a"),
        });
        yield* service.ingest({
          provider: "codex",
          payload: codexPayload(55),
          createdAt: "2026-08-15T12:00:01.000Z",
          providerInstanceId: asInstanceId("codex_b"),
        });
      }).pipe(Effect.provide(makeLayerAt(baseDir)));
      // A fresh service over the same state dir - the restart.
      const summary = yield* Effect.gen(function* () {
        const service = yield* AccountLimitsServiceModule.AccountLimitsService;
        return yield* service.readSummary();
      }).pipe(Effect.provide(makeLayerAt(baseDir)));
      expect(summary.snapshots.map((snapshot) => snapshot.instanceId)).toEqual([
        "codex_a",
        "codex_b",
      ]);
    }).pipe(Effect.scoped),
  );

  it.effect("rows for deleted instances are evicted; disabled instances are hidden", () =>
    Effect.gen(function* () {
      const service = yield* AccountLimitsServiceModule.AccountLimitsService;
      // codex_gone is not in settings at all; codex_b is disabled for this
      // test's roster below.
      yield* service.ingest({
        provider: "codex",
        payload: codexPayload(10),
        createdAt: "2026-08-15T12:00:00.000Z",
        providerInstanceId: asInstanceId("codex_gone"),
      });
      yield* service.ingest({
        provider: "codex",
        payload: codexPayload(20),
        createdAt: "2026-08-15T12:00:01.000Z",
        providerInstanceId: asInstanceId("codex_b"),
      });
      yield* service.ingest({
        provider: "codex",
        payload: codexPayload(30),
        createdAt: "2026-08-15T12:00:02.000Z",
        providerInstanceId: asInstanceId("codex_a"),
      });
      const summary = yield* service.readSummary();
      expect(summary.snapshots.map((snapshot) => snapshot.instanceId)).toEqual(["codex_a"]);
    }).pipe(
      Effect.provide(
        makeLayer({
          providerInstances: {
            [asInstanceId("codex_a")]: {
              driver: asDriver("codex"),
              config: { homePath: "/nonexistent/t3-test-codex-a" },
            },
            [asInstanceId("codex_b")]: {
              driver: asDriver("codex"),
              enabled: false,
              config: { homePath: "/nonexistent/t3-test-codex-b" },
            },
          },
        }),
      ),
    ),
  );
});

// Plain `it`: the seed consults the real clock for its retry floor and
// transcript-recency window, which the suite's virtual test clock (epoch
// 0) would defeat.
it.live("transcript seeding attributes a sole-owner dir and skips shared or disabled dirs", () =>
  Effect.gen(function* () {
    const soleDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-seed-sole-"));
    const sharedDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-seed-shared-"));
    const disabledDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-seed-disabled-"));
    // @effect-diagnostics-next-line preferSchemaOverJson:off - fabricates one raw transcript line.
    const line = JSON.stringify({
      timestamp: "2026-08-15T10:00:00.000Z",
      payload: { rate_limits: codexPayload(37) },
    });
    for (const dir of [soleDir, sharedDir, disabledDir]) {
      NodeFS.mkdirSync(NodePath.join(dir, "sessions"), { recursive: true });
      NodeFS.writeFileSync(NodePath.join(dir, "sessions", "rollout-1.jsonl"), `${line}\n`);
    }
    try {
      const summary = yield* Effect.gen(function* () {
        const service = yield* AccountLimitsServiceModule.AccountLimitsService;
        return yield* service.readSummary();
      }).pipe(
        Effect.provide(
          makeLayer({
            providerInstances: {
              // Pin the auto-derived default instance away from the real
              // ~/.codex - under the live clock this test's seed actually
              // runs, and it must never read this machine's transcripts.
              [asInstanceId("codex")]: {
                driver: asDriver("codex"),
                config: { homePath: "/nonexistent/t3-test-codex-default" },
              },
              [asInstanceId("codex_sole")]: {
                driver: asDriver("codex"),
                config: { homePath: soleDir },
              },
              // Two instances share one home: the dir has no honest owner.
              [asInstanceId("codex_s1")]: {
                driver: asDriver("codex"),
                config: { homePath: sharedDir, shadowHomePath: `${sharedDir}-shadow-1` },
              },
              [asInstanceId("codex_s2")]: {
                driver: asDriver("codex"),
                config: { homePath: sharedDir, shadowHomePath: `${sharedDir}-shadow-2` },
              },
              // Sole owner, but disabled: counted for ownership, never read.
              [asInstanceId("codex_off")]: {
                driver: asDriver("codex"),
                enabled: false,
                config: { homePath: disabledDir },
              },
            },
          }),
        ),
      );
      expect(
        summary.snapshots.map((snapshot) => [
          snapshot.instanceId,
          snapshot.source,
          snapshot.windows[0]?.usedPercent,
        ]),
      ).toEqual([["codex_sole", "transcript", 37]]);
    } finally {
      for (const dir of [soleDir, sharedDir, disabledDir]) {
        NodeFS.rmSync(dir, { recursive: true, force: true });
      }
    }
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.live(
  "a transcript seed settles a migrated row like a live event - evicted by another instance, re-seeded by its own",
  () =>
    Effect.gen(function* () {
      const workDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-seed-work-"));
      const defaultDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-seed-default-"));
      const baseDirs = [
        NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-limits-seed-a-")),
        NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-limits-seed-b-")),
      ];
      // Transcript lines must sit inside the seed's recency window, and the
      // default instance's line must be newer than the v1 row it replaces.
      const nowMs = yield* Clock.currentTimeMillis;
      const isoAt = (offsetMs: number) => DateTime.formatIso(DateTime.makeUnsafe(nowMs - offsetMs));
      const transcriptLine = (offsetMs: number, usedPercent: number) =>
        JSON.stringify({
          timestamp: isoAt(offsetMs),
          payload: { rate_limits: codexPayload(usedPercent) },
        });
      NodeFS.mkdirSync(NodePath.join(workDir, "sessions"), { recursive: true });
      NodeFS.writeFileSync(
        NodePath.join(workDir, "sessions", "rollout-1.jsonl"),
        `${transcriptLine(2 * 60 * 60 * 1000, 58)}\n`,
      );
      NodeFS.mkdirSync(NodePath.join(defaultDir, "sessions"), { recursive: true });
      NodeFS.writeFileSync(
        NodePath.join(defaultDir, "sessions", "rollout-1.jsonl"),
        `${transcriptLine(60 * 60 * 1000, 23)}\n`,
      );
      // A v1 cache: one codex row, no instanceId - "whichever account wrote
      // last", which may have been the work account as easily as the default.
      const writeV1Cache = (baseDir: string) => {
        NodeFS.mkdirSync(NodePath.join(baseDir, "userdata"), { recursive: true });
        NodeFS.writeFileSync(
          NodePath.join(baseDir, "userdata", "account-limits.json"),
          JSON.stringify([
            {
              provider: "codex",
              plan: "pro",
              windows: [
                {
                  id: "weekly",
                  label: "Weekly",
                  usedPercent: 12,
                  resetsAt: "2026-08-08T23:00:00.000Z",
                  windowMinutes: 10080,
                },
              ],
              asOf: isoAt(3 * 60 * 60 * 1000),
              source: "live",
            },
          ]),
        );
      };
      const roster = (defaultHome: string) => ({
        providerInstances: {
          [asInstanceId("codex")]: { driver: asDriver("codex"), config: { homePath: defaultHome } },
          [asInstanceId("codex_work")]: {
            driver: asDriver("codex"),
            config: { homePath: workDir },
          },
        },
      });
      const readRows = (baseDir: string, defaultHome: string) =>
        Effect.gen(function* () {
          const service = yield* AccountLimitsServiceModule.AccountLimitsService;
          const summary = yield* service.readSummary();
          return summary.snapshots.map((snapshot) => [
            snapshot.instanceId,
            snapshot.source,
            snapshot.windows[0]?.usedPercent,
          ]);
        }).pipe(Effect.provide(makeLayerAt(baseDir, roster(defaultHome))));
      try {
        // Only the work instance has transcripts: its seed is proof of a
        // distinct account, so the unconfirmed migrated row goes the way it
        // would under a live work event - evicted, not kept as a ghost.
        writeV1Cache(baseDirs[0]!);
        expect(yield* readRows(baseDirs[0]!, "/nonexistent/t3-test-codex-default")).toEqual([
          ["codex_work", "transcript", 58],
        ]);
        // The default instance has transcripts of its own: the same pass
        // seeds it back with real data, whichever order the seeds land in.
        writeV1Cache(baseDirs[1]!);
        expect(yield* readRows(baseDirs[1]!, defaultDir)).toEqual([
          ["codex", "transcript", 23],
          ["codex_work", "transcript", 58],
        ]);
      } finally {
        for (const dir of [workDir, defaultDir, ...baseDirs]) {
          NodeFS.rmSync(dir, { recursive: true, force: true });
        }
      }
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.live(
  "an unconfirmed migrated row keeps its v1 shape across restarts - the ghost eviction survives",
  () =>
    Effect.gen(function* () {
      const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-limits-restart-"));
      NodeFS.mkdirSync(NodePath.join(baseDir, "userdata"), { recursive: true });
      const cachePath = NodePath.join(baseDir, "userdata", "account-limits.json");
      // A v1 cache: one claude row, no instanceId.
      NodeFS.writeFileSync(
        cachePath,
        // @effect-diagnostics-next-line preferSchemaOverJson:off - fabricates the raw cache file.
        JSON.stringify([
          {
            provider: "claude",
            plan: "max",
            windows: [
              {
                id: "five_hour",
                label: "5h",
                usedPercent: 12,
                resetsAt: "2026-08-08T23:00:00.000Z",
                windowMinutes: 300,
              },
            ],
            asOf: "2026-08-01T00:00:00.000Z",
            source: "live",
          },
        ]),
      );
      const roster = {
        providerInstances: {
          [asInstanceId("claudeAgent")]: { driver: asDriver("claudeAgent") },
          [asInstanceId("claude_partner")]: { driver: asDriver("claudeAgent") },
          [asInstanceId("codex")]: {
            driver: asDriver("codex"),
            config: { homePath: "/nonexistent/t3-test-codex-default" },
          },
        },
      };
      try {
        // First run: an UNRELATED codex ingest persists the cache. The migrated
        // claude row must be written back in its v1 shape, still unconfirmed.
        yield* Effect.gen(function* () {
          const service = yield* AccountLimitsServiceModule.AccountLimitsService;
          yield* service.readSummary();
          yield* service.ingest({
            provider: asDriver("codex"),
            payload: codexPayload(41),
            createdAt: "2026-08-15T09:00:00.000Z",
            providerInstanceId: asInstanceId("codex"),
          });
        }).pipe(Effect.provide(makeLayerAt(baseDir, roster)));
        // @effect-diagnostics-next-line preferSchemaOverJson:off - reads the raw cache file back.
        const persisted = JSON.parse(NodeFS.readFileSync(cachePath, "utf8")) as {
          provider: string;
          instanceId?: string;
        }[];
        expect(
          persisted.map((row) => [row.provider, "instanceId" in row ? row.instanceId : "(none)"]),
        ).toEqual([
          ["claude", "(none)"],
          ["codex", "codex"],
        ]);
        // Second run - a restart. Live claude data on ANOTHER instance must
        // still evict the migrated default row instead of leaving a ghost.
        const summary = yield* Effect.gen(function* () {
          const service = yield* AccountLimitsServiceModule.AccountLimitsService;
          yield* service.ingest({
            provider: asDriver("claudeAgent"),
            payload: claudeUsagePayload(31, 9),
            createdAt: "2026-08-15T10:00:00.000Z",
            providerInstanceId: asInstanceId("claude_partner"),
          });
          return yield* service.readSummary();
        }).pipe(Effect.provide(makeLayerAt(baseDir, roster)));
        expect(
          summary.snapshots.map((snapshot) => [snapshot.provider, snapshot.instanceId]),
        ).toEqual([
          ["claude", "claude_partner"],
          ["codex", "codex"],
        ]);
      } finally {
        NodeFS.rmSync(baseDir, { recursive: true, force: true });
      }
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.live("drops untouched windows at every entry - the persisted cache and the streamed patch", () =>
  Effect.gen(function* () {
    const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-limits-untouched-"));
    NodeFS.mkdirSync(NodePath.join(baseDir, "userdata"), { recursive: true });
    const cachePath = NodePath.join(baseDir, "userdata", "account-limits.json");
    // A pre-upgrade cache row carrying a bare 0%/no-reset window next to a
    // metered one - written before untouched windows were filtered.
    NodeFS.writeFileSync(
      cachePath,
      // @effect-diagnostics-next-line preferSchemaOverJson:off - fabricates the raw cache file.
      JSON.stringify([
        {
          provider: "claude",
          plan: "max",
          windows: [
            {
              id: "five_hour",
              label: "5h",
              usedPercent: 12,
              resetsAt: "2026-08-08T23:00:00.000Z",
              windowMinutes: 300,
            },
            {
              id: "seven_day",
              label: "Week",
              usedPercent: 0,
              resetsAt: null,
              windowMinutes: 10080,
            },
          ],
          asOf: "2026-08-01T00:00:00.000Z",
          source: "live",
        },
      ]),
    );
    const roster = {
      providerInstances: {
        [asInstanceId("claudeAgent")]: { driver: asDriver("claudeAgent") },
        // A codex home that cannot exist, or the transcript seed reads this
        // machine's real ~/.codex/sessions mid-test (see instanceRoster).
        [asInstanceId("codex")]: {
          driver: asDriver("codex"),
          config: { homePath: "/nonexistent/t3-test-codex-untouched" },
        },
      },
    };
    try {
      const summary = yield* Effect.gen(function* () {
        const service = yield* AccountLimitsServiceModule.AccountLimitsService;
        // The loaded row must come back without its untouched window.
        const loaded = yield* service.readSummary();
        expect(
          loaded.snapshots.map((row) => [
            row.provider,
            row.instanceId,
            row.windows.map((w) => w.id),
          ]),
        ).toEqual([["claude", "claudeAgent", ["five_hour"]]]);
        // A streamed patch naming a window with no traffic must not add it:
        // no utilization and no reset clock is the untouched shape.
        yield* service.ingest({
          provider: asDriver("claudeAgent"),
          payload: {
            type: "rate_limit_event",
            rate_limit_info: { status: "allowed", rateLimitType: "seven_day" },
          },
          createdAt: "2026-08-15T10:00:00.000Z",
          providerInstanceId: asInstanceId("claudeAgent"),
        });
        // An untouched event naming the METERED window must not delete it -
        // the patch is dropped entirely, not filtered after the merge.
        yield* service.ingest({
          provider: asDriver("claudeAgent"),
          payload: {
            type: "rate_limit_event",
            rate_limit_info: { status: "allowed", rateLimitType: "five_hour" },
          },
          createdAt: "2026-08-15T10:00:01.000Z",
          providerInstanceId: asInstanceId("claudeAgent"),
        });
        // Not-applicable (API key / Bedrock / Vertex) keeps what was known.
        yield* service.ingest({
          provider: asDriver("claudeAgent"),
          payload: { rate_limits: null },
          createdAt: "2026-08-15T10:00:02.000Z",
          providerInstanceId: asInstanceId("claudeAgent"),
        });
        const kept = yield* service.readSummary();
        expect(kept.snapshots.map((row) => row.windows.map((w) => [w.id, w.usedPercent]))).toEqual([
          [["five_hour", 12]],
        ]);
        // An APPLICABLE snapshot whose windows are all untouched clears the
        // row - the meters really are empty now, not still at their old
        // readings.
        yield* service.ingest({
          provider: asDriver("claudeAgent"),
          payload: {
            subscription_type: "max",
            rate_limits: { five_hour: { utilization: 0 }, seven_day: { utilization: 0 } },
          },
          createdAt: "2026-08-15T10:00:03.000Z",
          providerInstanceId: asInstanceId("claudeAgent"),
        });
        return yield* service.readSummary();
      }).pipe(Effect.provide(makeLayerAt(baseDir, roster)));
      expect(summary.snapshots.map((row) => row.windows.map((w) => w.id))).toEqual([[]]);
      // The cleared row persisted back without windows - and the untouched
      // cache window never rode along to disk at any point.
      // @effect-diagnostics-next-line preferSchemaOverJson:off - reads the raw cache file back.
      const persisted = JSON.parse(NodeFS.readFileSync(cachePath, "utf8")) as {
        windows: { id: string }[];
      }[];
      expect(persisted.map((row) => row.windows.map((w) => w.id))).toEqual([[]]);
    } finally {
      NodeFS.rmSync(baseDir, { recursive: true, force: true });
    }
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.live("evicts a row whose instance now runs a different driver", () =>
  Effect.gen(function* () {
    const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-limits-flip-"));
    NodeFS.mkdirSync(NodePath.join(baseDir, "userdata"), { recursive: true });
    // A codex row cached while "personal" ran codex; the instance has since
    // been reconfigured to another driver, so the row's account no longer
    // exists here - and a stale row would be captioned with the new
    // driver's display name.
    NodeFS.writeFileSync(
      NodePath.join(baseDir, "userdata", "account-limits.json"),
      // @effect-diagnostics-next-line preferSchemaOverJson:off - fabricates the raw cache file.
      JSON.stringify([
        {
          provider: "codex",
          instanceId: "personal",
          plan: "pro",
          windows: [
            {
              id: "codex",
              label: "Week",
              usedPercent: 45,
              resetsAt: "2099-01-01T00:00:00.000Z",
              windowMinutes: 10080,
            },
          ],
          asOf: "2026-08-15T10:00:00.000Z",
          source: "live",
        },
      ]),
    );
    try {
      const summary = yield* Effect.gen(function* () {
        const service = yield* AccountLimitsServiceModule.AccountLimitsService;
        return yield* service.readSummary();
      }).pipe(
        Effect.provide(
          makeLayerAt(baseDir, {
            providerInstances: {
              [asInstanceId("codex")]: {
                driver: asDriver("codex"),
                config: { homePath: "/nonexistent/t3-test-codex-default" },
              },
              [asInstanceId("personal")]: { driver: asDriver("grok") },
            },
          }),
        ),
      );
      expect(summary.snapshots).toEqual([]);
    } finally {
      NodeFS.rmSync(baseDir, { recursive: true, force: true });
    }
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.live("seeds a codex instance homed by its environment's CODEX_HOME", () =>
  Effect.gen(function* () {
    // No homePath configured: the spawned CLI would resolve CODEX_HOME from
    // its child env, so the seed must read the same place.
    const envHome = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-seed-envhome-"));
    NodeFS.mkdirSync(NodePath.join(envHome, "sessions"), { recursive: true });
    NodeFS.writeFileSync(
      NodePath.join(envHome, "sessions", "rollout-1.jsonl"),
      // @effect-diagnostics-next-line preferSchemaOverJson:off - fabricates one raw transcript line.
      `${JSON.stringify({
        timestamp: "2026-08-15T10:00:00.000Z",
        payload: { rate_limits: codexPayload(29) },
      })}\n`,
    );
    try {
      const summary = yield* Effect.gen(function* () {
        const service = yield* AccountLimitsServiceModule.AccountLimitsService;
        return yield* service.readSummary();
      }).pipe(
        Effect.provide(
          makeLayer({
            providerInstances: {
              [asInstanceId("codex")]: {
                driver: asDriver("codex"),
                config: { homePath: "/nonexistent/t3-test-codex-default" },
              },
              [asInstanceId("codex_env")]: {
                driver: asDriver("codex"),
                environment: [{ name: "CODEX_HOME", value: envHome, sensitive: false }],
              },
            },
          }),
        ),
      );
      expect(
        summary.snapshots.map((snapshot) => [
          snapshot.instanceId,
          snapshot.source,
          snapshot.windows[0]?.usedPercent,
        ]),
      ).toEqual([["codex_env", "transcript", 29]]);
    } finally {
      NodeFS.rmSync(envHome, { recursive: true, force: true });
    }
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.live("a shadow-overlay instance seeds from its layout, not its CODEX_HOME env", () =>
  Effect.gen(function* () {
    const line = (percent: number) =>
      `${JSON.stringify({
        timestamp: "2026-08-15T10:00:00.000Z",
        payload: { rate_limits: codexPayload(percent) },
      })}\n`;
    const plainEnvHome = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-seed-plainenv-"));
    NodeFS.mkdirSync(NodePath.join(plainEnvHome, "sessions"), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(plainEnvHome, "sessions", "rollout-1.jsonl"), line(78));
    const shadowEnvHome = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-seed-shadowenv-"));
    NodeFS.mkdirSync(NodePath.join(shadowEnvHome, "sessions"), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(shadowEnvHome, "sessions", "rollout-1.jsonl"), line(77));
    try {
      const summary = yield* Effect.gen(function* () {
        const service = yield* AccountLimitsServiceModule.AccountLimitsService;
        return yield* service.readSummary();
      }).pipe(
        Effect.provide(
          makeLayer({
            providerInstances: {
              [asInstanceId("codex")]: {
                driver: asDriver("codex"),
                config: { homePath: "/nonexistent/t3-test-codex-default" },
              },
              // No shadow: the env home is where the CLI writes - seeded.
              [asInstanceId("codex_plain")]: {
                driver: asDriver("codex"),
                environment: [{ name: "CODEX_HOME", value: plainEnvHome, sensitive: false }],
              },
              // Shadow overlay: spawn pins CODEX_HOME to the overlay, so the
              // instance env value never reaches the CLI - the seed must not
              // read it either. (Its layout home may hold this machine's
              // real transcripts; the assertions below stay independent of
              // whatever that dir contains.)
              [asInstanceId("codex_shadow")]: {
                driver: asDriver("codex"),
                config: { shadowHomePath: "/nonexistent/t3-test-codex-shadow" },
                environment: [{ name: "CODEX_HOME", value: shadowEnvHome, sensitive: false }],
              },
            },
          }),
        ),
      );
      const plainRow = summary.snapshots.find((snapshot) => snapshot.instanceId === "codex_plain");
      expect(plainRow?.windows[0]?.usedPercent).toBe(78);
      // The trap percentage must appear on no row at all.
      expect(
        summary.snapshots.filter((snapshot) => snapshot.windows[0]?.usedPercent === 77),
      ).toEqual([]);
    } finally {
      NodeFS.rmSync(plainEnvHome, { recursive: true, force: true });
      NodeFS.rmSync(shadowEnvHome, { recursive: true, force: true });
    }
  }).pipe(Effect.provide(NodeServices.layer)),
);

describe("planCodexTranscriptSeeds", () => {
  const target = (
    instanceId: string,
    sessionsDir: string,
    enabled = true,
  ): AccountLimitsServiceModule.CodexSeedTarget => ({
    instanceId: asInstanceId(instanceId),
    sessionsDir,
    enabled,
  });

  it("keeps sole-owner sessions dirs and attributes them to their instance", () => {
    expect(
      AccountLimitsServiceModule.planCodexTranscriptSeeds([
        target("codex", "/home/user/.codex/sessions"),
      ]),
    ).toEqual([target("codex", "/home/user/.codex/sessions")]);
  });

  it("skips a dir that several instances write - no honest attribution exists", () => {
    // The reported setup: three instances share one homePath (shadow homes
    // symlink sessions/ back to it) - seeding any of them invents data.
    expect(
      AccountLimitsServiceModule.planCodexTranscriptSeeds([
        target("codex_a", "/home/user/.codex/sessions"),
        target("codex_b", "/home/user/.codex/sessions"),
        target("codex_c", "/home/user/.codex/sessions"),
      ]),
    ).toEqual([]);
  });

  it("counts disabled instances as owners - their transcripts share the dir", () => {
    expect(
      AccountLimitsServiceModule.planCodexTranscriptSeeds([
        target("codex_a", "/home/user/.codex/sessions"),
        target("codex_off", "/home/user/.codex/sessions", false),
      ]),
    ).toEqual([]);
  });

  it("plans independent dirs independently", () => {
    expect(
      AccountLimitsServiceModule.planCodexTranscriptSeeds([
        target("codex_a", "/home/user/.codex/sessions"),
        target("codex_b", "/home/user/.codex/sessions"),
        target("codex_work", "/home/user/.codex-work/sessions"),
      ]),
    ).toEqual([target("codex_work", "/home/user/.codex-work/sessions")]);
  });
});
