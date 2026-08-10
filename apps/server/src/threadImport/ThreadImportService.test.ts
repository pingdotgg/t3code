// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  DEFAULT_SERVER_SETTINGS,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  ProviderDriverKind,
  ProviderInstanceId,
  ProjectId,
  type ServerProvider,
  type ServerSettings,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Data from "effect/Data";
import { afterEach, describe, expect, it } from "@effect/vitest";

import type { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import type { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import type { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import type { ProviderSessionDirectory } from "../provider/Services/ProviderSessionDirectory.ts";
import type { ServerSettingsService } from "../serverSettings.ts";
import { makeThreadImportService } from "./ThreadImportService.ts";

const now = "2026-01-01T00:00:00.000Z";
const projectId = ProjectId.make("import-service-project");
const codexInstanceId = ProviderInstanceId.make("codex");
const claudeInstanceId = ProviderInstanceId.make("claudeAgent");
const temporaryDirectories: string[] = [];
const encodeJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

class DuplicateDispatchError extends Data.TaggedError("DuplicateDispatchError")<{
  readonly message: string;
}> {}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => NodeFSP.rm(directory, { recursive: true })),
  );
});

async function fixtureRoot(): Promise<{
  readonly root: string;
  readonly codexHome: string;
  readonly claudeHome: string;
}> {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-thread-import-service-"));
  const codexHome = NodePath.join(root, "codex-home");
  const claudeHome = NodePath.join(root, "claude-home");
  await NodeFSP.mkdir(codexHome, { recursive: true });
  await NodeFSP.mkdir(claudeHome, { recursive: true });
  temporaryDirectories.push(root);
  return { root, codexHome, claudeHome };
}

function provider(input: {
  readonly instanceId: ProviderInstanceId;
  readonly driver: "codex" | "claudeAgent";
}): ServerProvider {
  return {
    instanceId: input.instanceId,
    driver: ProviderDriverKind.make(input.driver),
    displayName: input.driver,
    enabled: true,
    installed: true,
    status: "ready",
    auth: { status: "authenticated" },
    version: null,
    checkedAt: now,
    models: [
      {
        slug: input.driver === "codex" ? "gpt-5-codex" : "claude-sonnet",
        name: input.driver,
        isCustom: false,
        isDefault: true,
        capabilities: null,
      },
    ],
    slashCommands: [],
    skills: [],
  };
}

function makeSettings(codexHome: string, claudeHome: string): ServerSettings {
  return {
    ...DEFAULT_SERVER_SETTINGS,
    providerInstances: {
      [String(codexInstanceId)]: {
        driver: ProviderDriverKind.make("codex"),
        config: { homePath: codexHome },
      },
      [String(claudeInstanceId)]: {
        driver: ProviderDriverKind.make("claudeAgent"),
        config: { homePath: claudeHome },
      },
    } as ServerSettings["providerInstances"],
  };
}

describe("ThreadImportService", () => {
  it.effect("imports resumable and transcript-only candidates idempotently", () =>
    Effect.gen(function* () {
      const { root, codexHome, claudeHome } = yield* Effect.promise(fixtureRoot);
      yield* Effect.promise(() =>
        Promise.all([
          NodeFSP.mkdir(NodePath.join(codexHome, "sessions"), { recursive: true }),
          NodeFSP.mkdir(NodePath.join(claudeHome, "projects"), { recursive: true }),
        ]),
      );
      yield* Effect.promise(() =>
        NodeFSP.writeFile(
          NodePath.join(codexHome, "sessions", "rollout.jsonl"),
          `${encodeJson({ type: "session_meta", payload: { id: "codex-session", cwd: root } })}\n${encodeJson({ type: "event_msg", payload: { type: "user_message", message: "Review this" } })}\n${encodeJson({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ text: "Looks good." }] } })}\n`,
        ),
      );
      yield* Effect.promise(() =>
        NodeFSP.writeFile(
          NodePath.join(claudeHome, "projects", "transcript.jsonl"),
          `${encodeJson({ type: "user", sessionId: "legacy-session", cwd: root, message: "Continue this" })}\n${encodeJson({ type: "assistant", sessionId: "legacy-session", cwd: root, message: "Transcript only" })}\n`,
        ),
      );

      const project = {
        id: projectId,
        title: "Import service project",
        workspaceRoot: root,
        defaultModelSelection: null,
        scripts: [],
        createdAt: now,
        updatedAt: now,
      };
      const importedThreadIds = new Set<string>();
      const bindings: unknown[] = [];
      const dispatched: Array<{ readonly type: string }> = [];
      let concurrentMode = false;
      let concurrentDispatchCount = 0;
      let releaseConcurrentFirst: (() => void) | undefined;
      const projection = {
        getProjectShellById: () => Effect.succeed(Option.some(project)),
        getSnapshot: () =>
          Effect.succeed({
            snapshotSequence: importedThreadIds.size,
            projects: [project],
            threads: [...importedThreadIds].map((id) => ({ id }) as never),
            updatedAt: now,
          }),
        getThreadShellById: (threadId: { readonly toString: () => string }) =>
          Effect.succeed(
            importedThreadIds.has(String(threadId))
              ? Option.some({ id: threadId } as never)
              : Option.none(),
          ),
      } as unknown as ProjectionSnapshotQuery["Service"];
      const dispatchOnce = (command: {
        readonly threadId: { readonly toString: () => string };
      }) => {
        const id = String(command.threadId);
        if (importedThreadIds.has(id)) {
          throw new DuplicateDispatchError({ message: "duplicate thread" });
        }
        importedThreadIds.add(id);
        dispatched.push(command as never);
        return { sequence: importedThreadIds.size };
      };
      const engine = {
        dispatch: (command: { readonly threadId: { readonly toString: () => string } }) => {
          if (!concurrentMode) return Effect.sync(() => dispatchOnce(command));
          concurrentDispatchCount += 1;
          return Effect.tryPromise({
            try: async () => {
              if (concurrentDispatchCount === 1) {
                await new Promise<void>((resolve) => {
                  releaseConcurrentFirst = resolve;
                });
              }
              const result = dispatchOnce(command);
              if (concurrentDispatchCount === 2) releaseConcurrentFirst?.();
              return result;
            },
            catch: (cause) =>
              cause instanceof DuplicateDispatchError
                ? cause
                : new DuplicateDispatchError({ message: String(cause) }),
          });
        },
      } as unknown as OrchestrationEngineService["Service"];
      const providerRegistry = {
        getProviders: Effect.succeed([
          provider({ instanceId: codexInstanceId, driver: "codex" }),
          provider({ instanceId: claudeInstanceId, driver: "claudeAgent" }),
        ]),
      } as unknown as ProviderRegistry["Service"];
      const providerSessions = {
        upsert: (binding: unknown) => {
          bindings.push(binding);
          return Effect.void;
        },
      } as unknown as ProviderSessionDirectory["Service"];
      const settingsService = {
        getSettings: Effect.succeed(makeSettings(codexHome, claudeHome)),
      } as unknown as ServerSettingsService["Service"];
      const service = makeThreadImportService({
        projection,
        engine,
        providerRegistry,
        providerSessions,
        settingsService,
      });

      const firstScan = yield* service.scan({ projectId });
      const secondScan = yield* service.scan({ projectId });
      expect(firstScan.candidates.map((candidate) => candidate.candidateId)).toEqual(
        secondScan.candidates.map((candidate) => candidate.candidateId),
      );
      expect(firstScan.candidates.map((candidate) => candidate.canResume)).toEqual([false, true]);

      const result = yield* service.commit({
        projectId,
        candidateIds: firstScan.candidates.map((candidate) => candidate.candidateId),
        runtimeMode: DEFAULT_RUNTIME_MODE,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      });
      expect(result.results.map((item) => item.status)).toEqual(["transcript-only", "imported"]);
      expect(bindings).toHaveLength(1);
      expect((bindings[0] as { readonly resumeCursor: unknown }).resumeCursor).toEqual({
        threadId: "codex-session",
      });
      expect(dispatched).toHaveLength(2);

      const duplicate = yield* service.commit({
        projectId,
        candidateIds: firstScan.candidates.map((candidate) => candidate.candidateId),
        runtimeMode: DEFAULT_RUNTIME_MODE,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      });
      expect(duplicate.results.map((item) => item.status)).toEqual([
        "already-imported",
        "already-imported",
      ]);
      expect(dispatched).toHaveLength(2);

      yield* Effect.promise(() =>
        NodeFSP.writeFile(
          NodePath.join(codexHome, "sessions", "concurrent.jsonl"),
          `${encodeJson({ type: "session_meta", payload: { id: "concurrent-session", cwd: root } })}\n${encodeJson({ type: "event_msg", payload: { type: "user_message", message: "Import concurrently" } })}\n`,
        ),
      );
      const concurrentCandidate = (yield* service.scan({ projectId })).candidates.find(
        (candidate) => candidate.title === "Import concurrently",
      );
      expect(concurrentCandidate).toBeDefined();
      concurrentMode = true;
      const concurrentResults = yield* Effect.all(
        [
          service.commit({
            projectId,
            candidateIds: [concurrentCandidate!.candidateId],
            runtimeMode: DEFAULT_RUNTIME_MODE,
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          }),
          service.commit({
            projectId,
            candidateIds: [concurrentCandidate!.candidateId],
            runtimeMode: DEFAULT_RUNTIME_MODE,
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          }),
        ],
        { concurrency: "unbounded" },
      );
      concurrentMode = false;
      expect(
        concurrentResults.flatMap((result) => result.results.map((item) => item.status)).toSorted(),
      ).toEqual(["already-imported", "imported"]);
      expect(dispatched).toHaveLength(3);
    }),
  );
});
