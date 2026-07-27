import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as S from "effect/Schema";

import * as Cloudflare from "alchemy/Cloudflare";

import * as AI from "alchemy/AI";
import { DevBox } from "../DevBox.ts";

export const path = AI.Parameter("path", S.String)`
The path to the file to search.`;

export const contents = AI.Parameter("contents", S.String)`
The contents of the file to write.`;

export class WriteFile extends AI.Tool<WriteFile>()("writeFile")`
Create or overwrite a file at the given ${path} with the provided ${contents}.` {}

export const Storage = Cloudflare.R2.Bucket("Storage");

export const WriteFileR2 = Layer.effect(
  WriteFile,
  Effect.gen(function* () {
    const bucket = yield* Cloudflare.R2.ReadWriteBucket(Storage);

    return ({ path, contents }) =>
      bucket.put(path, contents).pipe(Effect.orDie);
  }),
);

export const WriteFileDevBox = Layer.effect(
  WriteFile,
  Effect.gen(function* () {
    const devBox = yield* DevBox;

    return ({ path, contents }) => devBox.writeFile(path, contents);
  }),
);

export class ReadFile extends AI.Tool("readFile")`
Read the contents of a file at the given ${path}.` {}

export class EditFile extends AI.Tool("editFile")`
Apply a targeted edit to an existing file by replacing an exact string with a new one.` {}
