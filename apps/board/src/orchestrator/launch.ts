import type { ProviderOptionSelection } from "@t3tools/contracts";

import { BOARDS_DIR, type Board } from "../domain/board";
import type { ReviewTemplate } from "../domain/reviewTemplate";
import { type ProjectFiles, writeBoard } from "../store/boardFiles";
import type { UsageReading } from "../usage/usageNotice";
import { renderFacts } from "./brief";
import { type OrchestratorModel, ROLES, roleFiles } from "./roles";

export interface OrchestratorSelection extends OrchestratorModel {
  readonly driver: string;
  readonly model: string;
  /** The model's options, such as its effort. */
  readonly options: ReadonlyArray<ProviderOptionSelection>;
}

export interface LaunchRequest {
  readonly title: string;
  /** The first message, which holds the board facts. The standing rules ride on the instance. */
  readonly firstMessage: string;
  readonly instanceId: string;
  readonly model: string;
  readonly options: ReadonlyArray<ProviderOptionSelection>;
}

/** The engine calls that start the orchestrator and watch its first run. */
export interface LaunchPorts {
  readonly files: ProjectFiles;
  /** The orchestrator instance for the picked instance, created or updated with the standing rules. */
  readonly orchestratorInstance: (selection: OrchestratorSelection) => Promise<string>;
  readonly launchThread: (request: LaunchRequest) => Promise<string>;
  readonly projection: (threadId: string) => Promise<LaunchProjection>;
  /** Archives the thread of a launch that failed, so it does not stay in the thread list. */
  readonly discard: (threadId: string) => Promise<void>;
  readonly sleep: (ms: number) => Promise<void>;
}

/** The parts of a thread projection that tell whether its first run started. */
export interface LaunchProjection {
  readonly runs: ReadonlyArray<{ readonly status: string }>;
  readonly messages: ReadonlyArray<{ readonly role: string; readonly text: string }>;
  /** The messages of the thread's error items. */
  readonly failures: ReadonlyArray<{ readonly message: string }>;
}

export type LaunchSignal =
  | { readonly state: "pending" }
  | { readonly state: "started" }
  | { readonly state: "failed"; readonly message: string };

const ENDED_BADLY = ["failed", "cancelled", "interrupted", "rolled_back"];

/**
 * A launch has started when the orchestrator has produced text or finished a run. It has failed
 * when a run ended badly, which is how the engine reports a model the instance does not offer.
 */
export function readLaunchSignal(projection: LaunchProjection): LaunchSignal {
  const failed = projection.runs.find((run) => ENDED_BADLY.includes(run.status));
  if (failed !== undefined) {
    const message = projection.failures.at(-1)?.message ?? `The first run ${failed.status}.`;
    return { state: "failed", message };
  }
  const started =
    projection.runs.some((run) => run.status === "completed") ||
    projection.messages.some((message) => message.role === "assistant" && message.text !== "");
  return started ? { state: "started" } : { state: "pending" };
}

const POLL_MS = 500;
const SIGNAL_TIMEOUT_MS = 60_000;

/**
 * Copies the roles into the board folder, starts the orchestrator on the orchestrator instance
 * with the board facts, and saves its thread id in `board.json`. It returns once the orchestrator
 * has started, or throws with the engine's reason when the first run fails, and then the board
 * has no orchestrator again.
 */
export async function launchOrchestrator(
  ports: LaunchPorts,
  target: {
    readonly cwd: string;
    readonly folder: string;
    readonly board: Board;
    /** The project's title. */
    readonly project: string;
    /** The board's review template, which `board.reviewTemplate` names. */
    readonly reviewTemplate: ReviewTemplate;
    readonly usage: ReadonlyArray<UsageReading>;
  },
  selection: OrchestratorSelection,
): Promise<Board> {
  const { cwd, folder, board, project, reviewTemplate, usage } = target;
  const boardPath = `${BOARDS_DIR}/${folder}`;
  for (const role of ROLES) {
    const text = roleFiles.get(role.file);
    if (text === undefined) throw new Error(`The role file ${role.file} is missing from the app.`);
    await ports.files.write(cwd, `${boardPath}/roles/${role.file}`, text);
  }

  const instanceId = await ports.orchestratorInstance(selection);
  const threadId = await ports.launchThread({
    title: `Orchestrator: ${board.name}`,
    firstMessage: renderFacts({
      boardDir: `${cwd}/${boardPath}`,
      builderCap: board.builderCap,
      project,
      projectDir: cwd,
      reviewTemplate,
      usage,
    }),
    instanceId,
    model: selection.model,
    options: selection.options,
  });
  const launched: Board = { ...board, orchestratorThreadId: threadId };
  await writeBoard(ports.files, cwd, folder, launched);

  for (let waited = 0; waited < SIGNAL_TIMEOUT_MS; waited += POLL_MS) {
    const signal = readLaunchSignal(await ports.projection(threadId));
    if (signal.state === "started") return launched;
    if (signal.state === "failed") {
      await writeBoard(ports.files, cwd, folder, board);
      // The launch failure is the reason to show, so a thread that will not archive stays in the list.
      await ports.discard(threadId).catch(() => undefined);
      throw new Error(signal.message);
    }
    await ports.sleep(POLL_MS);
  }
  return launched;
}
