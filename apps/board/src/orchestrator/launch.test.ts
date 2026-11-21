import * as Result from "effect/Result";
import { describe, expect, it } from "vite-plus/test";

import { type Board, parseBoard } from "../domain/board";
import { SYSTEM_TEMPLATE } from "../domain/reviewTemplate";
import type { ProjectFiles } from "../store/boardFiles";
import {
  type LaunchPorts,
  type LaunchProjection,
  type LaunchRequest,
  launchOrchestrator,
  readLaunchSignal,
} from "./launch";
import { ROLES } from "./roles";

const CWD = "/work/project";
const BOARD: Board = {
  id: "b1",
  slug: "claude-connector",
  name: "Claude connector",
  projectId: "p1",
  orchestratorThreadId: null,
  createdAt: "2026-11-20T06:00:00.000Z",
  archived: false,
  builderCap: 2,
};
const SELECTION = {
  instanceId: "claudeAgent",
  driver: "claudeAgent",
  model: "claude-sonnet-5-5",
  offered: ["claude-sonnet-5-5", "claude-opus-5-5", "claude-haiku-5-5", "claude-fable-5-1"],
  options: [{ id: "effort", value: "medium" }],
};

const PENDING: LaunchProjection = { runs: [], messages: [], failures: [] };

function harness(answers: ReadonlyArray<LaunchProjection>) {
  const store = new Map<string, string>();
  const launched: LaunchRequest[] = [];
  const discarded: string[] = [];
  let polls = 0;
  const files: ProjectFiles = {
    list: async () => null,
    read: async (_cwd, path) => store.get(path) ?? null,
    write: async (_cwd, path, contents) => void store.set(path, contents),
  };
  const ports: LaunchPorts = {
    files,
    launchThread: async (request) => {
      launched.push(request);
      return "thread-1";
    },
    orchestratorInstance: async (selection) => `board-orchestrator-${selection.instanceId}`,
    projection: async () => answers[Math.min(polls++, answers.length - 1)] ?? PENDING,
    discard: async (id) => void discarded.push(id),
    sleep: async () => undefined,
  };
  return { ports, store, launched, discarded };
}

const boardJson = (store: Map<string, string>) => {
  const parsed = parseBoard(store.get(".agentboard/claude-connector/board.json") ?? "");
  return Result.isSuccess(parsed) ? parsed.success : null;
};

const target = {
  cwd: CWD,
  folder: "claude-connector",
  board: BOARD,
  project: "Connector",
  reviewTemplate: SYSTEM_TEMPLATE,
  usage: [],
};

describe("launching an orchestrator", () => {
  it("Given a board, when the orchestrator launches, then the roles are copied, the first message holds only the board facts, it runs on the orchestrator instance, and the thread id is saved", async () => {
    const { ports, store, launched } = harness([
      { ...PENDING, messages: [{ role: "assistant", text: "Ready." }] },
    ]);
    const board = await launchOrchestrator(ports, target, SELECTION);
    expect(board.orchestratorThreadId).toBe("thread-1");
    expect(boardJson(store)?.orchestratorThreadId).toBe("thread-1");
    for (const role of ROLES) {
      expect(store.has(`.agentboard/claude-connector/roles/${role.file}`)).toBe(true);
    }
    expect(launched).toHaveLength(1);
    expect(launched[0]).toMatchObject({
      instanceId: "board-orchestrator-claudeAgent",
      model: "claude-sonnet-5-5",
      options: [{ id: "effort", value: "medium" }],
      title: "Orchestrator: Claude connector",
    });
    expect(launched[0]?.firstMessage).toContain("/work/project/.agentboard/claude-connector");
    expect(launched[0]?.firstMessage).toContain("at most 2 building agents");
    expect(launched[0]?.firstMessage).toContain("`Connector`, at `/work/project`");
    expect(launched[0]?.firstMessage).not.toContain("delegate_task");
  });

  it("Given a model the instance does not offer, when the first run fails, then the engine's reason is thrown and the board has no orchestrator", async () => {
    const { ports, store, discarded } = harness([
      PENDING,
      {
        ...PENDING,
        runs: [{ status: "failed" }],
        failures: [
          {
            message:
              '{"type":"error","status":400,"error":{"message":"The \'gpt-nope\' model is not supported when using Codex with a ChatGPT account."}}',
          },
        ],
      },
    ]);
    await expect(launchOrchestrator(ports, target, SELECTION)).rejects.toThrow(
      "The 'gpt-nope' model is not supported when using Codex with a ChatGPT account.",
    );
    expect(boardJson(store)?.orchestratorThreadId).toBeNull();
    expect(discarded).toEqual(["thread-1"]);
  });
});

describe("the first signal of a launch", () => {
  it("Given a run that is still starting, when it is read, then it is pending", () => {
    expect(readLaunchSignal({ ...PENDING, runs: [{ status: "starting" }] })).toEqual({
      state: "pending",
    });
  });

  it("Given a plain-text failure, when it is read, then the text is kept", () => {
    const signal = readLaunchSignal({
      ...PENDING,
      runs: [{ status: "failed" }],
      failures: [{ message: "Claude gave up after repeated API errors." }],
    });
    expect(signal).toEqual({
      state: "failed",
      message: "Claude gave up after repeated API errors.",
    });
  });
});
