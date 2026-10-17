import { CommandId, type ProjectId, type ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import {
  ThreadTitleRegenerationTransform,
  ThreadTitleRegenerationTransformError,
} from "../orchestration-v2/ThreadTitleRegenerationService.ts";
import { getEffectiveCivilizationConfig } from "./ConfigService.ts";

type CitizenTitleRow = {
  readonly project_id: ProjectId;
  readonly name_display: string;
  readonly generation: number;
  readonly title_managed: number;
};

const byteLength = (value: string) => Buffer.byteLength(value, "utf8");

function composeTitle(
  template: string,
  input: {
    readonly name: string;
    readonly topic: string;
    readonly generation: number;
  },
) {
  return template
    .replaceAll("{name}", input.name)
    .replaceAll("{topic}", input.topic)
    .replaceAll("{generation}", String(input.generation));
}

function fitManagedTitle(
  template: string,
  input: {
    readonly name: string;
    readonly topic: string;
    readonly generation: number;
  },
) {
  const direct = composeTitle(template, input);
  if (byteLength(direct) <= 512) return direct;

  let topic = "";
  for (const character of input.topic) {
    const candidate = composeTitle(template, { ...input, topic: topic + character });
    if (byteLength(candidate) > 512) break;
    topic += character;
  }
  return composeTitle(template, { ...input, topic });
}

export const makeCivilizationTitleTransform = (sql: SqlClient.SqlClient) => ({
  transform: (input: {
    readonly threadId: ThreadId;
    readonly requestId: CommandId;
    readonly generatedTitle: string;
  }) =>
    Effect.gen(function* () {
      const citizen = (yield* sql<CitizenTitleRow>`
          SELECT project_id, name_display, generation, title_managed
          FROM civilization_citizens
          WHERE thread_id = ${input.threadId}
          LIMIT 1
        `)[0];
      if (citizen === undefined || citizen.title_managed !== 1) return input.generatedTitle;

      const effective = yield* getEffectiveCivilizationConfig(citizen.project_id).pipe(
        Effect.provideService(SqlClient.SqlClient, sql),
      );
      if (
        !effective.config.participation.enabled ||
        effective.config.participation.emergencyOff ||
        !effective.config.names.automaticTitles
      ) {
        return input.generatedTitle;
      }

      const managedTitle = fitManagedTitle(effective.config.names.titleTemplate, {
        name: citizen.name_display,
        topic: input.generatedTitle,
        generation: citizen.generation,
      });
      const completionCommandId = CommandId.make(`${input.requestId}:title-complete`);
      yield* sql`
        UPDATE civilization_citizens
        SET pending_title_command_id = ${completionCommandId},
            pending_managed_title = ${managedTitle},
            pending_title_topic = ${input.generatedTitle},
            revision = revision + 1,
            updated_at = datetime('now')
        WHERE thread_id = ${input.threadId} AND title_managed = 1
      `;
      return managedTitle;
    }).pipe(
      Effect.mapError(
        (cause) =>
          new ThreadTitleRegenerationTransformError({
            threadId: input.threadId,
            requestId: input.requestId,
            cause,
          }),
      ),
    ),
});

export const layerTitleTransform = Layer.effect(
  ThreadTitleRegenerationTransform,
  SqlClient.SqlClient.pipe(Effect.map(makeCivilizationTitleTransform)),
);
