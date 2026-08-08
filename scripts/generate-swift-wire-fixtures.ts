import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import * as Schema from "effect/Schema";
import {
  OrchestrationShellSnapshot,
  OrchestrationShellStreamItem,
  OrchestrationThreadDetailSnapshot,
  OrchestrationThreadStreamItem,
} from "../packages/contracts/src/orchestration.ts";

const root = resolve(import.meta.dirname, "..");
const outputDirectory = resolve(root, "apps/swift-ios/Tests/Fixtures/Wire");
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
const fixtures = new Map<string, unknown>([
  ["shell-snapshot.json", shellSnapshot],
  ["thread-detail-snapshot.json", threadDetail],
  [
    "shell-stream-snapshot.json",
    encodeShellStreamItem(decodeShellStreamItem({ kind: "snapshot", snapshot: shellSnapshot })),
  ],
  [
    "thread-stream-snapshot.json",
    encodeThreadStreamItem(decodeThreadStreamItem({ kind: "snapshot", snapshot: threadDetail })),
  ],
]);

let stale = false;
for (const [name, value] of fixtures) {
  const path = resolve(outputDirectory, name);
  const contents = `${JSON.stringify(value, null, 2)}\n`;
  if (check) {
    const current = await readFile(path, "utf8").catch(() => undefined);
    if (current !== contents) {
      console.error(`[swift-wire-fixtures] stale: ${name}`);
      stale = true;
    }
  } else {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, contents);
    console.log(`[swift-wire-fixtures] wrote ${name}`);
  }
}

if (stale) {
  console.error("Run `node scripts/generate-swift-wire-fixtures.ts` and commit the result.");
  process.exitCode = 1;
}
