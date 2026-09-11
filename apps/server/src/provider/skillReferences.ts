import { collectSkillReferences } from "@t3tools/shared/composerInlineTokens";
import { PROVIDER_SEND_TURN_MAX_INPUT_CHARS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { ProviderValidationError } from "./Errors.ts";

const encodeString = Schema.encodeSync(Schema.fromJsonString(Schema.String));

/** Bind explicit picks before provider routing, including providers without native skill inputs. */
export const expandSkillReferencesForProvider = Effect.fn("expandSkillReferencesForProvider")(
  function* (prompt: string) {
    const references = collectSkillReferences(prompt);
    if (references.length === 0) return prompt;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const blocks: string[] = [];
    for (const reference of references) {
      const info = yield* fileSystem.stat(reference.path).pipe(
        Effect.mapError(
          () =>
            new ProviderValidationError({
              operation: "ProviderService.sendTurn",
              issue: `Cannot read selected skill: ${reference.path}. Select an available skill and retry.`,
            }),
        ),
      );
      if (info.type !== "File" || info.size > BigInt(PROVIDER_SEND_TURN_MAX_INPUT_CHARS)) {
        return yield* new ProviderValidationError({
          operation: "ProviderService.sendTurn",
          issue: `Selected skill is not a readable file within the prompt size limit: ${reference.path}`,
        });
      }
      const contents = yield* fileSystem.readFileString(reference.path).pipe(
        Effect.mapError(
          () =>
            new ProviderValidationError({
              operation: "ProviderService.sendTurn",
              issue: `Cannot read selected skill: ${reference.path}. Select an available skill and retry.`,
            }),
        ),
      );
      blocks.push(
        [
          "The user explicitly selected this skill file. This source is authoritative for this invocation; follow its instructions rather than resolving the name again.",
          `Skill name: ${encodeString(reference.name)}`,
          `Skill file: ${encodeString(reference.path)}`,
          `Resolve relative skill resources from: ${encodeString(path.dirname(reference.path))}`,
          "Selected skill instructions:",
          contents,
        ].join("\n"),
      );
    }
    return `${prompt}\n\n${blocks.join("\n\n")}`;
  },
);
