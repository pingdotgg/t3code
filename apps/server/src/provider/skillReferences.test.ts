import { PROVIDER_SEND_TURN_MAX_INPUT_CHARS } from "@t3tools/contracts";
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
import { authorizeSkillReferences, expandSkillReferencesForProvider } from "./skillReferences.ts";
import { ProviderValidationError } from "./Errors.ts";

const encodeString = Schema.encodeSync(Schema.fromJsonString(Schema.String));

it.layer(NodeServices.layer)("selected skill sources", (it) => {
  it.effect(
    "authorizes canonical inventory members and rejects disabled, hidden, renamed, and undiscovered files",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped();
        const allowed = {
          name: "review",
          path: path.join(root, "allowed", "SKILL.md"),
          enabled: true,
        };
        const other = { name: "review", path: path.join(root, "other", "SKILL.md"), enabled: true };
        for (const skill of [allowed, other]) {
          yield* fs.makeDirectory(path.dirname(skill.path), { recursive: true });
          yield* fs.writeFileString(skill.path, "instructions");
        }
        yield* authorizeSkillReferences(
          [
            {
              ...allowed,
              path: `${root}${path.sep}other${path.sep}..${path.sep}allowed${path.sep}SKILL.md`,
            },
          ],
          [allowed],
        );
        for (const [reference, inventory] of [
          [other, [allowed]],
          [allowed, [{ ...allowed, enabled: false }]],
          [allowed, [{ ...allowed, userInvocable: false }]],
          [{ ...allowed, name: "invented" }, [allowed]],
          [allowed, []],
        ] as const) {
          let reads = 0;
          const failure = yield* authorizeSkillReferences([reference], inventory).pipe(
            Effect.andThen(expandSkillReferencesForProvider(serializeSkillReference(reference))),
            Effect.provideService(FileSystem.FileSystem, {
              ...fs,
              readFileString: (...args) => {
                reads++;
                return fs.readFileString(...args);
              },
            }),
            Effect.flip,
          );
          assert.instanceOf(failure, ProviderValidationError);
          assert.equal(reads, 0);
        }
      }),
  );

  it.effect("stops before reading a file that exceeds the remaining aggregate budget", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped();
      const references = ["first", "second", "third"].map((name) => ({
        name,
        path: path.join(root, name, "SKILL.md"),
      }));
      for (const reference of references) {
        yield* fs.makeDirectory(path.dirname(reference.path), { recursive: true });
        yield* fs.writeFileString(reference.path, "x".repeat(65_000));
      }
      const reads: string[] = [];
      const error = yield* expandSkillReferencesForProvider(
        references.map(serializeSkillReference).join(" "),
      ).pipe(
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          readFileString: (file, ...args) => {
            reads.push(file);
            return fs.readFileString(file, ...args);
          },
        }),
        Effect.flip,
      );
      assert.instanceOf(error, ProviderValidationError);
      assert.deepEqual(reads, [references[0]!.path]);
    }),
  );

  it.effect(
    "accepts the exact aggregate limit and rejects one extra character before reading",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped();
        const reference = { name: "review", path: path.join(root, "SKILL.md") };
        yield* fs.writeFileString(reference.path, "instructions");
        const prompt = serializeSkillReference(reference);
        const expanded = yield* expandSkillReferencesForProvider(prompt);
        const padding = " ".repeat(PROVIDER_SEND_TURN_MAX_INPUT_CHARS - expanded.length);
        assert.equal(
          (yield* expandSkillReferencesForProvider(prompt + padding)).length,
          PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
        );
        let reads = 0;
        yield* expandSkillReferencesForProvider(prompt + padding + " ").pipe(
          Effect.provideService(FileSystem.FileSystem, {
            ...fs,
            readFileString: (...args) => {
              reads++;
              return fs.readFileString(...args);
            },
          }),
          Effect.flip,
        );
        assert.equal(reads, 0);
      }),
  );

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
