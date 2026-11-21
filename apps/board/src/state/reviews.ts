import type { EnvironmentProject } from "@t3tools/client-runtime/state/models";
import { Atom, type AtomRegistry } from "effect/reactivity";
import * as Option from "effect/Option";

import { pickTemplate, type ReviewTemplate, templateFacts } from "../domain/reviewTemplate";
import { messageOrchestrator } from "../foryou/actions";
import { type ValidBoard, writeBoard } from "../store/boardFiles";
import { readingsFor, type UsageReading, usageCrossings } from "../usage/usageNotice";
import { boardEngine, localState, projectBoardsAtom } from "./boards";
import { engineEnvironmentIdAtom } from "./projects";
import { engineProvidersAtom } from "./server";

/** The templates the user built on the Reviews page. The saved list replaces the empty one on launch. */
export const reviewTemplatesAtom = Atom.writable(
  (get): ReadonlyArray<ReviewTemplate> => {
    void localState.read().then((state) => get.setSelf(state.reviewTemplates));
    return [];
  },
  (context, next: ReadonlyArray<ReviewTemplate>) => context.setSelf(next),
).pipe(Atom.keepAlive, Atom.withLabel("review-templates"));

export function saveReviewTemplates(
  registry: AtomRegistry.AtomRegistry,
  templates: ReadonlyArray<ReviewTemplate>,
) {
  registry.set(reviewTemplatesAtom, templates);
  return localState.update((state) => ({ ...state, reviewTemplates: templates }));
}

/**
 * Saves the board's template pick in `board.json`, where no name means the system template, and
 * tells a running orchestrator. Resolves to the failure text, or null once saved and sent.
 */
export async function setBoardReviewTemplate(
  registry: AtomRegistry.AtomRegistry,
  project: Pick<EnvironmentProject, "id" | "environmentId" | "workspaceRoot">,
  listed: ValidBoard,
  name: string | undefined,
): Promise<string | null> {
  const { reviewTemplate: _previous, ...rest } = listed.board;
  const board = name === undefined ? rest : { ...rest, reviewTemplate: name };
  try {
    await writeBoard(
      boardEngine(registry, project.environmentId).files,
      project.workspaceRoot,
      listed.folder,
      board,
    );
  } catch (failure) {
    return failure instanceof Error ? failure.message : String(failure);
  } finally {
    registry.refresh(projectBoardsAtom(project.id));
  }
  if (board.orchestratorThreadId === null) return null;
  const template = pickTemplate(name, (await localState.read()).reviewTemplates);
  return messageOrchestrator(
    registry,
    project.environmentId,
    board.orchestratorThreadId,
    async () =>
      `Review template changed to \`${template.name}\`. It applies from the next ticket.\n${templateFacts(template)}`,
  );
}

/**
 * The usage windows of one orchestrator's provider, by `<instance id>/<thread id>`. While a card
 * shows it, each window that passes 50, 80, or 95 percent sends the orchestrator one message.
 */
export const usageNoticeAtom = Atom.family((key: string) =>
  Atom.make<ReadonlyArray<UsageReading>>((get) => {
    const split = key.indexOf("/");
    const environmentId = get(engineEnvironmentIdAtom);
    const readings = readingsFor(get(engineProvidersAtom), key.slice(0, split), Date.now());
    const before = Option.getOrNull(get.self<ReadonlyArray<UsageReading>>());
    if (before !== null && environmentId !== null) {
      for (const message of usageCrossings(before, readings)) {
        void messageOrchestrator(
          get.registry,
          environmentId,
          key.slice(split + 1),
          async () => message,
        );
      }
    }
    return readings;
  }).pipe(Atom.withLabel(`usage-notice:${key}`)),
);
