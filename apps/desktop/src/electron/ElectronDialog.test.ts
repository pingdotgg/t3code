import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type { BrowserWindow } from "electron";
import { beforeEach, vi } from "vitest";

import * as ElectronDialog from "./ElectronDialog.ts";

const { showMessageBoxMock, showOpenDialogMock, showErrorBoxMock } = vi.hoisted(() => ({
  showMessageBoxMock: vi.fn(),
  showOpenDialogMock: vi.fn(),
  showErrorBoxMock: vi.fn(),
}));

vi.mock("electron", () => ({
  dialog: {
    showMessageBox: showMessageBoxMock,
    showOpenDialog: showOpenDialogMock,
    showErrorBox: showErrorBoxMock,
  },
}));

describe("ElectronDialog", () => {
  beforeEach(() => {
    showMessageBoxMock.mockReset();
    showOpenDialogMock.mockReset();
    showErrorBoxMock.mockReset();
  });

  it.effect("returns false without opening a confirm dialog for empty messages", () =>
    Effect.gen(function* () {
      const dialog = yield* ElectronDialog.ElectronDialog;

      const result = yield* dialog.confirm({
        message: "   ",
        owner: Option.none(),
      });

      assert.isFalse(result);
      assert.equal(showMessageBoxMock.mock.calls.length, 0);
    }).pipe(Effect.provide(ElectronDialog.layer)),
  );

  it.effect("opens a confirm dialog for the owner window", () =>
    Effect.gen(function* () {
      const owner = { id: 1 } as BrowserWindow;
      showMessageBoxMock.mockResolvedValue({ response: 1 });
      const dialog = yield* ElectronDialog.ElectronDialog;

      const result = yield* dialog.confirm({
        message: "Delete worktree?",
        owner: Option.some(owner),
      });

      assert.isTrue(result);
      assert.deepEqual(showMessageBoxMock.mock.calls[0], [
        owner,
        {
          type: "question",
          buttons: ["No", "Yes"],
          defaultId: 0,
          cancelId: 0,
          noLink: true,
          message: "Delete worktree?",
        },
      ]);
    }).pipe(Effect.provide(ElectronDialog.layer)),
  );

  it.effect("opens an app-level confirm dialog when there is no owner window", () =>
    Effect.gen(function* () {
      showMessageBoxMock.mockResolvedValue({ response: 0 });
      const dialog = yield* ElectronDialog.ElectronDialog;

      const result = yield* dialog.confirm({
        message: "Delete worktree?",
        owner: Option.none(),
      });

      assert.isFalse(result);
      assert.deepEqual(showMessageBoxMock.mock.calls[0], [
        {
          type: "question",
          buttons: ["No", "Yes"],
          defaultId: 0,
          cancelId: 0,
          noLink: true,
          message: "Delete worktree?",
        },
      ]);
    }).pipe(Effect.provide(ElectronDialog.layer)),
  );
});
