import * as Effect from "effect/Effect";

export interface ZipFile {
  path: string;
  content: string | Uint8Array<ArrayBufferLike>;
}

export const zipCode = Effect.fn(function* (
  content: string | Uint8Array<ArrayBufferLike>,
  files?: ReadonlyArray<ZipFile>,
) {
  // Create a zip buffer in memory
  const zip = new (yield* Effect.promise(() => import("jszip"))).default();
  const date = new Date("1980-01-01T00:00:00.000Z");
  zip.file("index.mjs", content, { date });
  for (const file of files ?? []) {
    zip.file(file.path, file.content, { date });
  }

  return yield* Effect.promise(() =>
    zip.generateAsync({
      type: "nodebuffer",
      compression: "DEFLATE",
      platform: "UNIX",
    }),
  );
});
