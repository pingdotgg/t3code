// @effect-diagnostics nodeBuiltinImport:off -- The id is a plain file in a temporary directory.
import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { readOrCreateEditorClientId } from "./editorClientId.ts";

it.effect("keeps one id per installation and never shares it between installations", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const first = yield* fs.makeTempDirectoryScoped({ prefix: "t3-editor-id-a-" });
    const second = yield* fs.makeTempDirectoryScoped({ prefix: "t3-editor-id-b-" });

    const id = readOrCreateEditorClientId(first);
    assert.match(id ?? "", /^[a-f0-9-]{36}$/);
    assert.strictEqual(readOrCreateEditorClientId(first), id);
    assert.notStrictEqual(readOrCreateEditorClientId(second), id);

    yield* fs.writeFileString(path.join(first, "editor-client-id"), "not-an-id");
    assert.strictEqual(readOrCreateEditorClientId(first), null);
    assert.strictEqual(readOrCreateEditorClientId(path.join(first, "missing", "dir")), null);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
