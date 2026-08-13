import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { beforeEach, vi } from "vite-plus/test";

const { openExternalMock, openPathMock, writeTextMock } = vi.hoisted(() => ({
  openExternalMock: vi.fn(),
  openPathMock: vi.fn(),
  writeTextMock: vi.fn(),
}));

vi.mock("electron", () => ({
  shell: {
    openExternal: openExternalMock,
    openPath: openPathMock,
  },
  clipboard: {
    writeText: writeTextMock,
  },
}));

import * as ElectronShell from "./ElectronShell.ts";

describe("ElectronShell", () => {
  beforeEach(() => {
    openExternalMock.mockReset();
    openPathMock.mockReset();
    writeTextMock.mockReset();
  });

  it.effect("opens safe external URLs", () =>
    Effect.gen(function* () {
      openExternalMock.mockResolvedValue(undefined);

      const electronShell = yield* ElectronShell.ElectronShell;
      const result = yield* electronShell.openExternal("https://example.com/path");

      assert.equal(result, true);
      assert.deepEqual(openExternalMock.mock.calls, [["https://example.com/path"]]);
    }).pipe(Effect.provide(ElectronShell.layer)),
  );

  it.effect("does not open unsafe external URLs", () =>
    Effect.gen(function* () {
      const electronShell = yield* ElectronShell.ElectronShell;
      const result = yield* electronShell.openExternal("file:///etc/passwd");

      assert.equal(result, false);
      assert.equal(openExternalMock.mock.calls.length, 0);
    }).pipe(Effect.provide(ElectronShell.layer)),
  );

  it.effect("returns false when Electron rejects openExternal", () =>
    Effect.gen(function* () {
      openExternalMock.mockRejectedValue(new Error("open failed"));

      const electronShell = yield* ElectronShell.ElectronShell;
      const result = yield* electronShell.openExternal("https://example.com/path");

      assert.equal(result, false);
    }).pipe(Effect.provide(ElectronShell.layer)),
  );

  it.effect("opens the exact local path in its default application", () =>
    Effect.gen(function* () {
      openPathMock.mockResolvedValue("");
      const path = "/Users/toviastorres/Downloads/product image.png";

      const electronShell = yield* ElectronShell.ElectronShell;
      yield* electronShell.openPath(path);

      assert.deepEqual(openPathMock.mock.calls, [[path]]);
    }).pipe(Effect.provide(ElectronShell.layer)),
  );

  it.effect("fails observably when Electron cannot open a local path", () =>
    Effect.gen(function* () {
      openPathMock.mockResolvedValue("There is no application set to open the file.");

      const electronShell = yield* ElectronShell.ElectronShell;
      const error = yield* Effect.flip(electronShell.openPath("/tmp/product.bin"));

      assert.equal(error.reason, "open-refused");
      assert.equal(error.cause, undefined);
      assert.equal(error.message, 'Unable to open "/tmp/product.bin" in its default application');
    }).pipe(Effect.provide(ElectronShell.layer)),
  );

  it.effect("preserves Electron rejections as the underlying cause", () =>
    Effect.gen(function* () {
      const cause = new Error("open failed");
      openPathMock.mockRejectedValue(cause);

      const electronShell = yield* ElectronShell.ElectronShell;
      const error = yield* Effect.flip(electronShell.openPath("/tmp/product.bin"));

      assert.equal(error.reason, "shell-rejected");
      assert.equal(error.cause, cause);
      assert.equal(error.message, 'Unable to open "/tmp/product.bin" in its default application');
    }).pipe(Effect.provide(ElectronShell.layer)),
  );
});
