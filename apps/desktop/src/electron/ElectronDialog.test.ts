import { assert, describe, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type { BrowserWindow } from "electron";
import { beforeEach, vi } from "vite-plus/test";

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

  it.effect("preserves folder picker request context and cause", () =>
    Effect.gen(function* () {
      const cause = new Error("folder picker failed");
      const owner = { id: 7 } as BrowserWindow;
      showOpenDialogMock.mockRejectedValue(cause);
      const dialog = yield* ElectronDialog.ElectronDialog;

      const error = yield* Effect.flip(
        dialog.pickFolder({
          owner: Option.some(owner),
          defaultPath: Option.some("/workspace"),
        }),
      );

      assert.instanceOf(error, ElectronDialog.ElectronDialogPickFolderError);
      assert.isTrue(ElectronDialog.isElectronDialogError(error));
      assert.strictEqual(error.ownerWindowId, 7);
      assert.strictEqual(error.defaultPath, "/workspace");
      assert.strictEqual(error.cause, cause);
      assert.include(error.message, "window 7");
      assert.include(error.message, "/workspace");
      assert.notInclude(error.message, cause.message);
    }).pipe(Effect.provide(ElectronDialog.layer)),
  );

  it.effect("opens a single-file picker when multiple selections are disabled", () =>
    Effect.gen(function* () {
      showOpenDialogMock.mockResolvedValue({
        canceled: false,
        filePaths: ["/pictures/icon.png"],
      });
      const dialog = yield* ElectronDialog.ElectronDialog;

      const paths = yield* dialog.pickFiles({
        owner: Option.none(),
        defaultPath: Option.some("/project"),
        filters: [{ name: "Images", extensions: ["png"] }],
        multiple: false,
      });

      assert.deepEqual(paths, ["/pictures/icon.png"]);
      assert.deepEqual(showOpenDialogMock.mock.calls, [
        [
          {
            defaultPath: "/project",
            filters: [{ name: "Images", extensions: ["png"] }],
            properties: ["openFile"],
          },
        ],
      ]);
    }).pipe(Effect.provide(ElectronDialog.layer)),
  );

  it.effect("preserves message box request context and cause", () =>
    Effect.gen(function* () {
      const cause = new Error("message box failed");
      showMessageBoxMock.mockRejectedValue(cause);
      const dialog = yield* ElectronDialog.ElectronDialog;

      const error = yield* Effect.flip(
        dialog.showMessageBox({
          type: "warning",
          title: "Unsaved changes",
          message: "Discard changes?",
          detail: "This cannot be undone.",
          buttons: ["Cancel", "Discard"],
        }),
      );

      assert.instanceOf(error, ElectronDialog.ElectronDialogShowMessageBoxError);
      assert.strictEqual(error.type, "warning");
      assert.strictEqual(error.titleLength, "Unsaved changes".length);
      assert.strictEqual(error.messageLength, "Discard changes?".length);
      assert.strictEqual(error.detailLength, "This cannot be undone.".length);
      assert.strictEqual(error.buttonCount, 2);
      assert.notProperty(error, "title");
      assert.notProperty(error, "dialogMessage");
      assert.notProperty(error, "dialogDetail");
      assert.notProperty(error, "buttons");
      assert.strictEqual(error.cause, cause);
      assert.include(error.message, "warning");
      assert.notInclude(error.message, "Unsaved changes");
      assert.notInclude(error.message, "Discard changes?");
      assert.notInclude(error.message, "This cannot be undone.");
      assert.notInclude(error.message, "Cancel");
      assert.notInclude(error.message, "Discard");
      assert.notInclude(error.message, cause.message);
    }).pipe(Effect.provide(ElectronDialog.layer)),
  );

  it.effect("preserves error box request context and cause in the defect", () =>
    Effect.gen(function* () {
      const cause = new Error("error box failed");
      showErrorBoxMock.mockImplementation(() => {
        throw cause;
      });
      const dialog = yield* ElectronDialog.ElectronDialog;

      const exit = yield* Effect.exit(dialog.showErrorBox("Startup failed", "Could not start."));

      assert.isTrue(exit._tag === "Failure");
      if (exit._tag === "Success") return;
      const error = Cause.squash(exit.cause);
      assert.instanceOf(error, ElectronDialog.ElectronDialogShowErrorBoxError);
      assert.strictEqual(error.titleLength, "Startup failed".length);
      assert.strictEqual(error.contentLength, "Could not start.".length);
      assert.notProperty(error, "title");
      assert.notProperty(error, "content");
      assert.strictEqual(error.cause, cause);
      assert.notInclude(error.message, "Startup failed");
      assert.notInclude(error.message, "Could not start.");
      assert.notInclude(error.message, cause.message);
    }).pipe(Effect.provide(ElectronDialog.layer)),
  );
});
