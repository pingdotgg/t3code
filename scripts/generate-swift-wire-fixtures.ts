import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import {
  ClientOrchestrationCommand,
  ProviderConsumeResetCreditInput,
  ProviderConsumeResetCreditResult,
  ServerProviderResetCredits,
  OrchestrationShellSnapshot,
  OrchestrationShellStreamItem,
  OrchestrationThreadDetailSnapshot,
  OrchestrationThreadStreamItem,
} from "@t3tools/contracts";

const check = process.argv.includes("--check");
const timestamp = "2026-08-07T12:00:00.000Z";

const project = {
  id: "project-fixture",
  title: "Fixture project",
  workspaceRoot: "/workspace/fixture",
  repositoryIdentity: null,
  defaultModelSelection: {
    instanceId: "codex",
    model: "gpt-5.6-sol",
    options: [{ id: "effort", value: "high" }],
  },
  scripts: [],
  createdAt: timestamp,
  updatedAt: timestamp,
  deletedAt: null,
};

const threadShell = {
  id: "thread-fixture",
  projectId: project.id,
  title: "Fixture thread",
  modelSelection: project.defaultModelSelection,
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: "main",
  worktreePath: null,
  branchPullRequest: {
    projectId: project.id,
    repository: "fixture/repository",
    number: 42,
    url: "https://example.com/fixture/repository/pull/42",
  },
  activeOrderKey: "nm",
  latestTurn: null,
  createdAt: timestamp,
  updatedAt: timestamp,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  snoozedUntil: null,
  snoozedAt: null,
  pinnedAt: null,
  titleRegeneration: null,
  session: null,
  latestUserMessageAt: timestamp,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  hasActionableProposedPlan: false,
  backgroundLiveness: null,
  planProgress: null,
};

const shellSnapshotInput = {
  snapshotSequence: 42,
  projects: [project],
  threads: [threadShell],
  updatedAt: timestamp,
};

const threadDetailInput = {
  snapshotSequence: 42,
  thread: {
    ...threadShell,
    deletedAt: null,
    messages: [
      {
        id: "message-fixture",
        role: "user",
        text: "Verify the native wire contract",
        attachments: [],
        turnId: "turn-fixture",
        streaming: false,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    ],
    proposedPlans: [],
    activities: [],
    checkpoints: [],
  },
  page: {
    beforeCursor: "fixture-cursor",
    hasMore: true,
    snapshotSequence: 42,
    threadSequence: 40,
  },
};

const decodeShellSnapshot = Schema.decodeUnknownSync(OrchestrationShellSnapshot);
const encodeShellSnapshot = Schema.encodeSync(OrchestrationShellSnapshot);
const decodeThreadDetail = Schema.decodeUnknownSync(OrchestrationThreadDetailSnapshot);
const encodeThreadDetail = Schema.encodeSync(OrchestrationThreadDetailSnapshot);
const decodeShellStreamItem = Schema.decodeUnknownSync(OrchestrationShellStreamItem);
const encodeShellStreamItem = Schema.encodeSync(OrchestrationShellStreamItem);
const decodeThreadStreamItem = Schema.decodeUnknownSync(OrchestrationThreadStreamItem);
const encodeThreadStreamItem = Schema.encodeSync(OrchestrationThreadStreamItem);

const shellSnapshot = encodeShellSnapshot(decodeShellSnapshot(shellSnapshotInput));
const threadDetail = encodeThreadDetail(decodeThreadDetail(threadDetailInput));
const serializeFixture = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;
const fixtures = new Map<string, string>([
  [
    "question-attachment-command.json",
    serializeFixture(
      Schema.encodeSync(ClientOrchestrationCommand)(
        Schema.decodeUnknownSync(ClientOrchestrationCommand)({
          type: "thread.user-input.respond",
          commandId: "command-fixture",
          threadId: threadShell.id,
          requestId: "question-fixture",
          createdAt: timestamp,
          answers: { scope: "Server and Web" },
          attachmentsByQuestionId: {
            scope: [
              {
                type: "image",
                id: "attachment-fixture",
                name: "screenshot.png",
                mimeType: "image/png",
                sizeBytes: 2,
              },
            ],
          },
        }),
      ),
    ),
  ],
  [
    "hub-reset-credit-input.json",
    serializeFixture(
      Schema.encodeSync(ProviderConsumeResetCreditInput)(
        Schema.decodeUnknownSync(ProviderConsumeResetCreditInput)({
          sourceId: "hub-fixture",
          accountId: "account-fixture",
          creditId: "credit-fixture",
        }),
      ),
    ),
  ],
  [
    "hub-reset-credit-result.json",
    serializeFixture(
      Schema.encodeSync(ProviderConsumeResetCreditResult)(
        Schema.decodeUnknownSync(ProviderConsumeResetCreditResult)({
          outcome: "reset",
          warning: "Could not clear the hub cooldown.",
        }),
      ),
    ),
  ],
  [
    "hub-reset-credits.json",
    serializeFixture(
      Schema.encodeSync(ServerProviderResetCredits)(
        Schema.decodeUnknownSync(ServerProviderResetCredits)({
          availableCount: 1,
          nextCreditId: "credit-fixture",
          nextExpiresAt: timestamp,
        }),
      ),
    ),
  ],
  [
    "question-dismiss-command.json",
    serializeFixture(
      Schema.encodeSync(ClientOrchestrationCommand)(
        Schema.decodeUnknownSync(ClientOrchestrationCommand)({
          type: "thread.user-input.dismiss",
          commandId: "command-fixture",
          threadId: threadShell.id,
          requestId: "question-fixture",
          createdAt: timestamp,
        }),
      ),
    ),
  ],
  ["shell-snapshot.json", serializeFixture(shellSnapshot)],
  ["thread-detail-snapshot.json", serializeFixture(threadDetail)],
  [
    "shell-stream-snapshot.json",
    serializeFixture(
      encodeShellStreamItem(decodeShellStreamItem({ kind: "snapshot", snapshot: shellSnapshot })),
    ),
  ],
  [
    "thread-stream-snapshot.json",
    serializeFixture(
      encodeThreadStreamItem(decodeThreadStreamItem({ kind: "snapshot", snapshot: threadDetail })),
    ),
  ],
]);

class StaleWireFixturesError extends Schema.TaggedError<StaleWireFixturesError>()(
  "StaleWireFixturesError",
  {
    staleFixtures: Schema.Array(Schema.String),
  },
) {
  override get message(): string {
    return "Run `node scripts/generate-swift-wire-fixtures.ts` and commit the result.";
  }
}

const generateSwiftWireFixtures = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const root = path.resolve(import.meta.dirname, "..");
  const outputDirectory = path.resolve(root, "apps/swift-ios/Tests/Fixtures/Wire");

  const staleFixtures: string[] = [];
  for (const [name, contents] of fixtures) {
    const filePath = path.resolve(outputDirectory, name);
    if (check) {
      const current = yield* fs
        .readFileString(filePath)
        .pipe(Effect.catch(() => Effect.succeed(undefined)));
      if (current !== contents) {
        yield* Effect.logError(`[swift-wire-fixtures] stale: ${name}`);
        staleFixtures.push(name);
      }
    } else {
      yield* fs.makeDirectory(path.dirname(filePath), { recursive: true });
      yield* fs.writeFileString(filePath, contents);
      yield* Effect.log(`[swift-wire-fixtures] wrote ${name}`);
    }
  }

  if (staleFixtures.length > 0) {
    return yield* new StaleWireFixturesError({ staleFixtures });
  }
});

generateSwiftWireFixtures.pipe(Effect.provide(NodeServices.layer), NodeRuntime.runMain);
