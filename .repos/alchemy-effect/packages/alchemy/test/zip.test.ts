import { sha256 } from "@/Util/sha256";
import { zipCode } from "@/Util/zip";
import * as Effect from "effect/Effect";
import { expect, test } from "vitest";

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
