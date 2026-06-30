import { WorkflowDefinition } from "@t3tools/contracts";
import { AsanaSelector, GithubSelector, JiraSelector } from "@t3tools/contracts/workSource";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import {
  BoardRegistry,
  BoardRegistryError,
  type BoardRegistryShape,
} from "../Services/BoardRegistry.ts";
import { lintWorkflowDefinition } from "../workflowFile.ts";

const decodeWorkflowDefinition = Schema.decodeUnknownEffect(WorkflowDefinition);
const isWorkflowDefinition = Schema.is(WorkflowDefinition);

const make = Effect.gen(function* () {
  const store = yield* Ref.make<Map<string, WorkflowDefinition>>(new Map());

  const register: BoardRegistryShape["register"] = (boardId, raw) =>
    Effect.gen(function* () {
      const definition = isWorkflowDefinition(raw)
        ? raw
        : yield* decodeWorkflowDefinition(raw).pipe(
            Effect.mapError(
              (cause) => new BoardRegistryError({ message: `Invalid workflow: ${String(cause)}` }),
            ),
          );
      const errors = lintWorkflowDefinition(definition, {
        providerInstanceExists: () => true,
        // The registry has no provider-capability info; the strict loader lint
        // is the real continueSession resume gate. Stay permissive here.
        providerInstanceSupportsResume: () => true,
        instructionFileExists: () => true,
        selectorSchemaFor: (p) =>
          p === "github" ? GithubSelector : p === "asana" ? AsanaSelector : p === "jira" ? JiraSelector : null,
      });
      if (errors.length > 0) {
        return yield* new BoardRegistryError({
          message: `Workflow lint failed: ${errors.map((error) => error.code).join(", ")}`,
        });
      }

      yield* Ref.update(store, (current) => new Map(current).set(boardId as string, definition));
      return definition;
    });

  const getDefinition: BoardRegistryShape["getDefinition"] = (boardId) =>
    Ref.get(store).pipe(Effect.map((current) => current.get(boardId as string) ?? null));

  const listDefinitions: BoardRegistryShape["listDefinitions"] = () =>
    Ref.get(store).pipe(
      Effect.map((current) =>
        Array.from(current.entries()).map(([boardId, definition]) => ({
          boardId: boardId as never,
          definition,
        })),
      ),
    );

  const unregister: BoardRegistryShape["unregister"] = (boardId) =>
    Ref.update(store, (current) => {
      const next = new Map(current);
      next.delete(boardId as string);
      return next;
    });

  const getLane: BoardRegistryShape["getLane"] = (boardId, laneKey) =>
    getDefinition(boardId).pipe(
      Effect.map((definition) => definition?.lanes.find((lane) => lane.key === laneKey) ?? null),
    );

  return {
    register,
    unregister,
    getDefinition,
    listDefinitions,
    getLane,
  } satisfies BoardRegistryShape;
});

export const BoardRegistryLive = Layer.effect(BoardRegistry, make);
