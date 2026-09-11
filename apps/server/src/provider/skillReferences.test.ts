import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  collectSkillReferences,
  serializeSkillReference,
} from "@t3tools/shared/composerInlineTokens";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { expandSkillReferencesForProvider } from "./skillReferences.ts";
import { ProviderValidationError } from "./Errors.ts";

const encodeString = Schema.encodeSync(Schema.fromJsonString(Schema.String));

it.layer(NodeServices.layer)("selected skill sources", (it) => {
  it.effect("loads only the selected file, even when another source has the same name", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped();
      const skills = ["plugin", "personal"].map((source) => ({
        name: "code-review",
        path: path.join(root, source, "SKILL.md"),
      }));
      for (const skill of skills) {
        yield* fs.makeDirectory(path.dirname(skill.path), { recursive: true });
        yield* fs.writeFileString(
          skill.path,
          skill === skills[0] ? "OFFICIAL_INSTRUCTIONS" : "MATT_STANDARDS_AND_SPEC",
        );
      }
      for (const skill of skills) {
        const prompt = `Use ${serializeSkillReference(skill)} now.`;
        const expanded = yield* expandSkillReferencesForProvider(prompt);
        assert.include(
          expanded,
          skill === skills[0] ? "OFFICIAL_INSTRUCTIONS" : "MATT_STANDARDS_AND_SPEC",
        );
        assert.notInclude(
          expanded,
          skill === skills[0] ? "MATT_STANDARDS_AND_SPEC" : "OFFICIAL_INSTRUCTIONS",
        );
        assert.deepEqual(collectSkillReferences(expanded), [skill]);
        assert.include(expanded, encodeString(path.dirname(skill.path)));
      }
    }),
  );
  it.effect("fails before dispatch when the selected source disappeared", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped();
      const prompt = serializeSkillReference({
        name: "code-review",
        path: path.join(root, "SKILL.md"),
      });
      const error = yield* expandSkillReferencesForProvider(prompt).pipe(Effect.flip);
      assert.instanceOf(error, ProviderValidationError);
    }),
  );
});
