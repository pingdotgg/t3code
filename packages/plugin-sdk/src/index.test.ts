import { describe, expect, it } from "vite-plus/test";
import * as Effect from "effect/Effect";

import { definePlugin, HOST_API_VERSION, writeFileAtomic } from "./index.ts";

describe("definePlugin", () => {
  it("preserves the plugin definition shape", () => {
    const definition = definePlugin({
      register: () => Effect.succeed({ rpc: [] }),
    });

    expect(typeof definition.register).toBe("function");
    expect(HOST_API_VERSION).toBe("1.0.0");
  });

  it("writeFileAtomic writes a sibling temp file then renames it into place", async () => {
    // oxlint-disable-next-line t3code/no-manual-effect-runtime-in-tests -- plugin-sdk uses vite-plus/test and does not depend on @effect/vitest.
    await Effect.runPromise(
      Effect.gen(function* () {
        const operations: string[] = [];
        const fs = {
          writeFile: ({
            relativePath,
            contents,
          }: {
            readonly relativePath: string;
            readonly contents: Uint8Array;
          }) =>
            Effect.sync(() => {
              operations.push(`write:${relativePath}:${new TextDecoder().decode(contents)}`);
            }),
          rename: ({
            fromRelativePath,
            toRelativePath,
          }: {
            readonly fromRelativePath: string;
            readonly toRelativePath: string;
          }) =>
            Effect.sync(() => {
              operations.push(`rename:${fromRelativePath}->${toRelativePath}`);
            }),
          remove: ({ relativePath }: { readonly relativePath: string }) =>
            Effect.sync(() => {
              operations.push(`remove:${relativePath}`);
            }),
        } as any;

        yield* writeFileAtomic(fs, {
          root: "/repo",
          relativePath: "notes/today.md",
          contents: "hello",
        });

        expect(operations).toHaveLength(2);
        expect(operations[0]).toMatch(/^write:notes\/\.today\.md\.[a-z0-9-]+\.tmp:hello$/);
        expect(operations[1]).toMatch(
          /^rename:notes\/\.today\.md\.[a-z0-9-]+\.tmp->notes\/today\.md$/,
        );
      }),
    );
  });
});
