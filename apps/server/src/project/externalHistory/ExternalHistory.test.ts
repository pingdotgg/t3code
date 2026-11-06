import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  type ExternalHistorySettings,
} from "@t3tools/contracts";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import {
  ProviderNativeHistoryError,
  type ProviderNativeHistory,
  type ProviderNativeHistoryThread,
} from "@t3tools/provider-core/server/nativeHistory";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../../config.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as ProviderInstanceRegistry from "../../provider/ProviderInstanceRegistry.ts";
import * as ExternalHistory from "./ExternalHistory.ts";

const thread: ProviderNativeHistoryThread = {
  nativeThreadId: "outside-t3",
  cwd: "/source-project",
  title: "Native conversation",
  preview: "Searchable evidence",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  source: "cli",
  originator: "codex_cli_rs",
  ephemeral: false,
};
const item = {
  nativeThreadId: thread.nativeThreadId,
  nativeTurnId: "turn",
  nativeItemId: "item",
  kind: "commandExecution",
  role: "tool",
  status: "completed",
  createdAt: null,
  digest: "a".repeat(64),
  readCursor: "source-cursor",
  text: "needle",
  textOffset: 100,
  totalChars: 200,
  truncated: true,
  match: { start: 100, end: 106 },
} as const;

const makeFixture = Effect.fn("ExternalHistory.test.fixture")(function* () {
  const calls = {
    list: [] as Array<Parameters<ProviderNativeHistory["list"]>[0]>,
    items: [] as Array<Parameters<ProviderNativeHistory["items"]>[0]>,
    read: [] as Array<Parameters<ProviderNativeHistory["readSource"]>[0]>,
  };
  const native: ProviderNativeHistory = {
    list: (input) =>
      Effect.sync(() => {
        calls.list.push(input);
        return { threads: input.archived ? [] : [thread], nextCursor: null };
      }),
    items: (input) =>
      Effect.sync(() => {
        calls.items.push(input);
        return input.cursor === undefined
          ? { thread, items: [], examinedItems: 20, nextCursor: "next-items" }
          : { thread, items: [item], examinedItems: 1, nextCursor: null };
      }),
    readSource: (input) =>
      Effect.sync(() => {
        calls.read.push(input);
        return {
          thread,
          item: { ...item, text: "exact evidence", textOffset: input.textOffset ?? 0 },
          nextTextOffset: null,
        };
      }),
  };
  const unused = () => Effect.die("This reader must not run a provider session or generation.");
  const instance: ProviderInstance = {
    instanceId: ProviderInstanceId.make("codex"),
    driverKind: ProviderDriverKind.make("codex"),
    continuationIdentity: {
      driverKind: ProviderDriverKind.make("codex"),
      continuationKey: "codex:home:/shared",
    },
    displayName: "Shared Codex",
    enabled: true,
    nativeHistory: native,
    snapshot: {
      resolveMaintenance: unused,
      getSnapshot: unused(),
      refresh: unused(),
      streamChanges: Stream.empty,
      applyUsageLimits: unused,
      markLimited: unused,
    },
    orchestrationAdapter: {
      instanceId: ProviderInstanceId.make("codex"),
      driver: ProviderDriverKind.make("codex"),
      getCapabilities: unused,
      planSelectionTransition: unused,
      openSession: unused,
    },
    textGeneration: {
      supportedOperations: [],
      generateCommitMessage: unused,
      generatePrContent: unused,
      generateBranchName: unused,
      generateThreadTitle: unused,
      generateReviewGuide: unused,
      generateTranscriptionPostProcessing: unused,
      generateKnowledgeCandidates: unused,
      generateConversationSummary: unused,
      generateModelEvaluation: unused,
    },
  };
  const state = {
    instances: [instance] as Array<ProviderInstance>,
    settings: { enabled: true, chatGptExportPaths: [] } as ExternalHistorySettings,
    registryReads: 0,
  };
  const service = yield* ExternalHistory.ExternalHistory.pipe(
    Effect.provide(
      ExternalHistory.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            ServerConfig.layerTest("/operational-project", { prefix: "t3-external-config-" }),
            Layer.mock(ServerSettings.ServerSettingsService)({
              getSettings: Effect.sync(() => ({
                ...DEFAULT_SERVER_SETTINGS,
                externalHistory: state.settings,
              })),
            }),
            Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
              listInstances: Effect.sync(() => {
                state.registryReads++;
                return state.instances;
              }),
            }),
          ),
        ),
      ),
    ),
  );
  return { service, state, calls, instance, native };
});

it.layer(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))("external history service", (it) => {
  it.effect("checks the environment opt-in before touching providers and on every read", () =>
    Effect.gen(function* () {
      const { service, state, calls } = yield* makeFixture();
      state.settings = { enabled: false, chatGptExportPaths: [] };
      expect(yield* service.query({ operation: "sources" })).toEqual({
        operation: "sources",
        enabled: false,
        sources: [],
      });
      expect(state.registryReads).toBe(0);
      const error = yield* service
        .query({ operation: "search", sourceId: "unknown", query: "needle" })
        .pipe(Effect.flip);
      expect(error.reason).toBe("disabled");
      expect(calls.list).toEqual([]);
      state.settings = { enabled: true, chatGptExportPaths: [] };
      const sources = yield* service.query({ operation: "sources" });
      if (sources.operation !== "sources") return yield* Effect.die("wrong response");
      state.settings = { enabled: false, chatGptExportPaths: [] };
      const disabledRead = yield* service
        .query({
          operation: "read",
          ref: {
            sourceId: sources.sources[0]!.id,
            threadId: "outside-t3",
            readCursor: "source-cursor",
            digest: item.digest,
          },
        })
        .pipe(Effect.flip);
      expect(disabledRead.reason).toBe("disabled");
      expect(calls.read).toEqual([]);
    }),
  );

  it.effect("paginates empty native pages before advancing explicitly to archived history", () =>
    Effect.gen(function* () {
      const { service, calls } = yield* makeFixture();
      const sources = yield* service.query({ operation: "sources" });
      if (sources.operation !== "sources") return yield* Effect.die("wrong response");
      const request = {
        operation: "search",
        sourceId: sources.sources[0]!.id,
        query: "needle",
        includeArchived: true,
        filterCwd: "/source-project",
      } as const;
      const first = yield* service.query(request);
      if (first.operation !== "search") return yield* Effect.die("wrong response");
      expect(first.matches).toEqual([]);
      expect(first.nextCursor).not.toBeNull();
      const mismatched = yield* service
        .query({ ...request, query: "different", cursor: first.nextCursor! })
        .pipe(Effect.flip);
      expect(mismatched.reason).toBe("invalid_cursor");
      const second = yield* service.query({ ...request, cursor: first.nextCursor! });
      if (second.operation !== "search") return yield* Effect.die("wrong response");
      expect(second.matches[0]?.ref.threadId).toBe("outside-t3");
      expect(second.matches[0]?.excerpt).toBe("needle");
      expect(calls.list).toEqual([
        { cwd: "/operational-project", filterCwd: "/source-project", archived: false, limit: 1 },
      ]);
      const third = yield* service.query({ ...request, cursor: second.nextCursor! });
      if (third.operation !== "search") return yield* Effect.die("wrong response");
      expect(third.nextCursor).toBeNull();
      expect(calls.list.at(-1)?.archived).toBe(true);
      expect(calls.items).toHaveLength(2);
      const read = yield* service.query({
        operation: "read",
        ref: second.matches[0]!.ref,
        textOffset: 101,
        maxChars: 200,
      });
      expect(read.operation).toBe("read");
      expect(calls.read).toEqual([
        {
          cwd: "/operational-project",
          nativeThreadId: "outside-t3",
          readCursor: "source-cursor",
          digest: item.digest,
          textOffset: 101,
          maxChars: 200,
        },
      ]);
    }),
  );

  it.effect("deduplicates a shared Codex identity and invalidates removed or changed sources", () =>
    Effect.gen(function* () {
      const { service, state, instance, native } = yield* makeFixture();
      state.instances = [
        instance,
        { ...instance, instanceId: ProviderInstanceId.make("codex-other") },
      ];
      const sources = yield* service.query({ operation: "sources" });
      if (sources.operation !== "sources") return yield* Effect.die("wrong response");
      expect(sources.sources).toHaveLength(1);
      expect(sources.sources[0]?.label).toBe("Shared Codex");
      state.instances = [
        {
          ...instance,
          continuationIdentity: {
            ...instance.continuationIdentity,
            continuationKey: "codex:home:/different",
          },
        },
      ];
      const missing = yield* service
        .query({ operation: "search", sourceId: sources.sources[0]!.id, query: "needle" })
        .pipe(Effect.flip);
      expect(missing.reason).toBe("missing");
      state.instances = [
        {
          ...instance,
          nativeHistory: {
            ...native,
            list: () =>
              Effect.fail(
                new ProviderNativeHistoryError({ operation: "list", reason: "unsupported" }),
              ),
          },
        },
      ];
      const unsupported = yield* service
        .query({ operation: "search", sourceId: sources.sources[0]!.id, query: "needle" })
        .pipe(Effect.flip);
      expect(unsupported.reason).toBe("unsupported");
      state.instances = [{ ...instance, enabled: false }];
      expect(yield* service.query({ operation: "sources" })).toEqual({
        operation: "sources",
        enabled: true,
        sources: [],
      });
    }),
  );

  it.effect("reads only configured exports without copying or importing their transcript", () =>
    Effect.gen(function* () {
      const { service, state } = yield* makeFixture();
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-external-service-" });
      const file = `${directory}/conversations.json`;
      const contents =
        '[{"id":"chatgpt","title":"Export","current_node":"one","mapping":{"one":{"parent":null,"message":{"id":"message","author":{"role":"user"},"content":{"parts":["needle"]}}}}}]';
      yield* fs.writeFileString(file, contents);
      state.instances = [];
      state.settings = { enabled: true, chatGptExportPaths: [file, file] };
      const sources = yield* service.query({ operation: "sources" });
      if (sources.operation !== "sources") return yield* Effect.die("wrong response");
      expect(sources.sources).toHaveLength(1);
      expect(sources.sources[0]?.kind).toBe("chatgpt_export");
      const result = yield* service.query({
        operation: "search",
        sourceId: sources.sources[0]!.id,
        query: "needle",
      });
      if (result.operation !== "search") return yield* Effect.die("wrong response");
      expect(result.matches[0]?.excerpt).toBe("needle");
      for (const sourceId of [file, "../../private/conversations.json", "chatgpt:../private"]) {
        expect(
          (yield* service
            .query({ operation: "search", sourceId, query: "needle" })
            .pipe(Effect.flip)).reason,
        ).toBe("missing");
        expect(
          (yield* service
            .query({ operation: "read", ref: { ...result.matches[0]!.ref, sourceId } })
            .pipe(Effect.flip)).reason,
        ).toBe("missing");
      }
      state.settings = { enabled: true, chatGptExportPaths: [] };
      expect(
        (yield* service.query({ operation: "read", ref: result.matches[0]!.ref }).pipe(Effect.flip))
          .reason,
      ).toBe("missing");
      expect(yield* fs.readFileString(file)).toBe(contents);
      expect(yield* fs.readDirectory(directory)).toEqual(["conversations.json"]);
    }).pipe(Effect.scoped),
  );

  it.effect("rejects a native continuation that cannot fit the public cursor budget", () =>
    Effect.gen(function* () {
      const { service, state, instance, native } = yield* makeFixture();
      state.instances = [
        {
          ...instance,
          nativeHistory: {
            ...native,
            items: () =>
              Effect.succeed({
                thread,
                items: [],
                examinedItems: 1,
                nextCursor: '"'.repeat(9_000),
              }),
          },
        },
      ];
      const sources = yield* service.query({ operation: "sources" });
      if (sources.operation !== "sources") return yield* Effect.die("wrong response");
      const error = yield* service
        .query({ operation: "search", sourceId: sources.sources[0]!.id, query: "needle" })
        .pipe(Effect.flip);
      expect(error.reason).toBe("limit_exceeded");
    }),
  );

  it.effect("uses another reader for the same home only after availability or API failures", () =>
    Effect.gen(function* () {
      const { service, state, instance, native, calls } = yield* makeFixture();
      state.instances = [
        {
          ...instance,
          nativeHistory: {
            ...native,
            list: () =>
              Effect.fail(
                new ProviderNativeHistoryError({ operation: "list", reason: "unsupported" }),
              ),
          },
        },
        { ...instance, instanceId: ProviderInstanceId.make("codex-compatible") },
      ];
      const sources = yield* service.query({ operation: "sources" });
      if (sources.operation !== "sources") return yield* Effect.die("wrong response");
      expect(sources.sources).toHaveLength(1);
      const request = {
        operation: "search",
        sourceId: sources.sources[0]!.id,
        query: "needle",
      } as const;
      expect((yield* service.query(request)).operation).toBe("search");
      expect(calls.list).toHaveLength(1);
      state.instances = [
        {
          ...instance,
          nativeHistory: {
            ...native,
            list: () =>
              Effect.fail(new ProviderNativeHistoryError({ operation: "list", reason: "changed" })),
          },
        },
        { ...instance, instanceId: ProviderInstanceId.make("codex-compatible") },
      ];
      expect((yield* service.query(request).pipe(Effect.flip)).reason).toBe("changed");
      expect(calls.list).toHaveLength(1);
    }),
  );
});
