import { collectSkillReferences } from "@t3tools/shared/composerInlineTokens";
import { PROVIDER_SEND_TURN_MAX_INPUT_CHARS, type ServerProvider } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { ProviderValidationError } from "./Errors.ts";

const encodeString = Schema.encodeSync(Schema.fromJsonString(Schema.String));

/** Only enabled, user-invocable sources discovered by this provider may be dispatched. */
export const authorizeSkillReferences = Effect.fn("authorizeSkillReferences")(function* (
  references: ReturnType<typeof collectSkillReferences>,
  inventory: ServerProvider["skills"],
) {
  const fs = yield* FileSystem.FileSystem;
  for (const reference of references) {
    const candidates = (inventory ?? []).filter(
      (skill) => skill.enabled && skill.userInvocable !== false && skill.name === reference.name,
    );
    const reject = () =>
      new ProviderValidationError({
        operation: "ProviderService.sendTurn",
        issue: `Selected skill is not an available, user-invocable source: ${reference.path}. Refresh skills and retry.`,
      });
    if (candidates.length === 0) return yield* reject();
    const canonical = yield* fs.realPath(reference.path).pipe(Effect.mapError(reject));
    let authorized = false;
    for (const candidate of candidates) {
      const candidatePath = yield* fs
        .realPath(candidate.path)
        .pipe(Effect.catch(() => Effect.succeed(undefined)));
      if (candidatePath === canonical) {
        authorized = true;
        break;
      }
    }
    if (!authorized) return yield* reject();
  }
});

/** Exact-file fallback for providers without native path-bound skill inputs. */
export const expandSkillReferencesForProvider = Effect.fn("expandSkillReferencesForProvider")(
  function* (prompt: string, references = collectSkillReferences(prompt)) {
    if (references.length === 0) return prompt;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const blocks: string[] = [];
    let size = prompt.length;
    const overflow = () =>
      new ProviderValidationError({
        operation: "ProviderService.sendTurn",
        issue: `Selected skill instructions exceed the ${PROVIDER_SEND_TURN_MAX_INPUT_CHARS} character prompt limit.`,
      });
    if (size > PROVIDER_SEND_TURN_MAX_INPUT_CHARS) return yield* overflow();
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
      const header =
        [
          "The user explicitly selected this skill file. This source is authoritative for this invocation; follow its instructions rather than resolving the name again.",
          `Skill name: ${encodeString(reference.name)}`,
          `Skill file: ${encodeString(reference.path)}`,
          `Resolve relative skill resources from: ${encodeString(path.dirname(reference.path))}`,
          "Selected skill instructions:",
        ].join("\n") + "\n";
      // Conservatively budget UTF-8 bytes before reading, then check the decoded character count.
      const remaining = PROVIDER_SEND_TURN_MAX_INPUT_CHARS - size - 2 - header.length;
      if (remaining < 0 || info.size > BigInt(remaining)) return yield* overflow();
      const contents = yield* fileSystem.readFileString(reference.path).pipe(
        Effect.mapError(
          () =>
            new ProviderValidationError({
              operation: "ProviderService.sendTurn",
              issue: `Cannot read selected skill: ${reference.path}. Select an available skill and retry.`,
            }),
        ),
      );
      if (contents.length > remaining) return yield* overflow();
      size += 2 + header.length + contents.length;
      blocks.push(header + contents);
    }
    return `${prompt}\n\n${blocks.join("\n\n")}`;
  },
);
