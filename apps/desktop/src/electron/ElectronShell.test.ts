import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { beforeEach, vi } from "vite-plus/test";

const { openExternalMock, writeTextMock } = vi.hoisted(() => ({
  openExternalMock: vi.fn(),
  writeTextMock: vi.fn(),
}));

vi.mock("electron", () => ({
  shell: {
    openExternal: openExternalMock,
  },
  clipboard: {
    writeText: writeTextMock,
  },
}));

import * as ElectronShell from "./ElectronShell.ts";

describe("ElectronShell", () => {
  beforeEach(() => {
    openExternalMock.mockReset();
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

  it.effect("preserves the URL and cause when Electron rejects openExternal", () =>
    Effect.gen(function* () {
      const cause = new Error("open failed");
      openExternalMock.mockRejectedValue(cause);

      const electronShell = yield* ElectronShell.ElectronShell;
      const error = yield* Effect.flip(
        electronShell.openExternal("https://example.com/path?view=desktop"),
      );

      assert.instanceOf(error, ElectronShell.ElectronShellOpenExternalError);
      assert.isTrue(ElectronShell.isElectronShellError(error));
      assert.strictEqual(error.externalUrl, "https://example.com/path?view=desktop");
      assert.strictEqual(error.cause, cause);
      assert.include(error.message, error.externalUrl);
      assert.notInclude(error.message, cause.message);
    }).pipe(Effect.provide(ElectronShell.layer)),
  );

  it.effect("preserves non-sensitive clipboard context and cause", () =>
    Effect.gen(function* () {
      const cause = new Error("clipboard failed");
      writeTextMock.mockImplementation(() => {
        throw cause;
      });

      const electronShell = yield* ElectronShell.ElectronShell;
      const error = yield* Effect.flip(electronShell.copyText("secret text"));

      assert.instanceOf(error, ElectronShell.ElectronShellCopyTextError);
      assert.isTrue(ElectronShell.isElectronShellError(error));
      assert.strictEqual(error.textLength, 11);
      assert.strictEqual(error.cause, cause);
      assert.include(error.message, "11 characters");
      assert.notInclude(error.message, "secret text");
      assert.notInclude(error.message, cause.message);
    }).pipe(Effect.provide(ElectronShell.layer)),
  );
});
