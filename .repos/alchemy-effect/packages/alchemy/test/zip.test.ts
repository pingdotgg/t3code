import { sha256 } from "@/Util/sha256";
import { zipCode } from "@/Util/zip";
import * as Effect from "effect/Effect";
import { expect, test } from "alchemy-test";

test("zipCode is deterministic for identical inputs", async () => {
  const hash = () =>
    Effect.runPromise(
      zipCode("export default 1", [
        {
          path: "index.mjs.map",
          content: JSON.stringify({
            version: 3,
            sources: ["index.ts"],
          }),
        },
      ]).pipe(Effect.flatMap(sha256)),
    );

  const first = await hash();
  await new Promise((resolve) => setTimeout(resolve, 1100));
  expect(await hash()).toBe(first);
});

// Nested paths make JSZip synthesize intermediate folder entries; those must
// carry the fixed archive date or the bytes differ across builds.
test("zipCode is deterministic for nested package paths", async () => {
  const build = () =>
    Effect.runPromise(
      zipCode("export default 1", [
        {
          path: "node_modules/uuid/package.json",
          content: JSON.stringify({ name: "uuid" }),
        },
      ]),
    );

  const first = await build();
  const zip = await (await import("jszip")).default.loadAsync(first);
  for (const entry of Object.values(zip.files)) {
    expect(entry.date.toISOString()).toBe("1980-01-01T00:00:00.000Z");
  }

  await new Promise((resolve) => setTimeout(resolve, 1100));
  const second = await build();
  expect(await Effect.runPromise(sha256(second))).toBe(
    await Effect.runPromise(sha256(first)),
  );
});
