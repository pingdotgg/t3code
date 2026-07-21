import { assert, describe, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type { BrowserWindow } from "electron";
import { beforeEach, vi } from "vite-plus/test";

import * as ElectronDialog from "./ElectronDialog.ts";

const { showMessageBoxMock, showOpenDialogMock, showErrorBoxMock, getFileIconMock } = vi.hoisted(
  () => ({
    showMessageBoxMock: vi.fn(),
    showOpenDialogMock: vi.fn(),
    showErrorBoxMock: vi.fn(),
    getFileIconMock: vi.fn(),
  }),
);

vi.mock("electron", () => ({
  app: { getFileIcon: getFileIconMock },
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
    getFileIconMock.mockReset();
  });

  it.effect("selects a macOS application and resolves its system icon", () =>
    Effect.gen(function* () {
      const owner = { id: 12 } as BrowserWindow;
      showOpenDialogMock.mockResolvedValue({
        canceled: false,
        filePaths: ["/Applications/Terminal.app"],
      });
      getFileIconMock.mockResolvedValue({ toDataURL: () => "data:image/png;base64,icon" });
      const dialog = yield* ElectronDialog.ElectronDialog;

      const result = yield* dialog.pickApplication({ owner: Option.some(owner) });

      assert.deepEqual(Option.getOrNull(result), {
        applicationPath: "/Applications/Terminal.app",
        suggestedName: "Terminal",
        iconDataUrl: "data:image/png;base64,icon",
      });
      assert.deepEqual(showOpenDialogMock.mock.calls[0], [
        owner,
        {
          defaultPath: "/Applications",
          properties: ["openFile"],
          filters: [{ name: "Applications", extensions: ["app"] }],
        },
      ]);
    }).pipe(Effect.provide(ElectronDialog.layer)),
  );

  it.effect("returns none when application selection is cancelled", () =>
    Effect.gen(function* () {
      showOpenDialogMock.mockResolvedValue({ canceled: true, filePaths: [] });
      const dialog = yield* ElectronDialog.ElectronDialog;
      assert.isTrue(Option.isNone(yield* dialog.pickApplication({ owner: Option.none() })));
      assert.equal(getFileIconMock.mock.calls.length, 0);
    }).pipe(Effect.provide(ElectronDialog.layer)),
  );

  it.effect("keeps a valid selection when icon extraction fails", () =>
    Effect.gen(function* () {
      showOpenDialogMock.mockResolvedValue({
        canceled: false,
        filePaths: ["/Users/test/Applications/My Tool.app"],
      });
      getFileIconMock.mockRejectedValue(new Error("icon unavailable"));
      const dialog = yield* ElectronDialog.ElectronDialog;

      assert.deepEqual(Option.getOrNull(yield* dialog.pickApplication({ owner: Option.none() })), {
        applicationPath: "/Users/test/Applications/My Tool.app",
        suggestedName: "My Tool",
        iconDataUrl: null,
      });
    }).pipe(Effect.provide(ElectronDialog.layer)),
  );

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

  it.effect("preserves confirmation request context and cause", () =>
    Effect.gen(function* () {
      const cause = new Error("confirmation failed");
      const owner = { id: 9 } as BrowserWindow;
      showMessageBoxMock.mockRejectedValue(cause);
      const dialog = yield* ElectronDialog.ElectronDialog;

      const error = yield* Effect.flip(
        dialog.confirm({
          owner: Option.some(owner),
          message: "  Confirm removal?  ",
        }),
      );

      assert.instanceOf(error, ElectronDialog.ElectronDialogConfirmError);
      assert.strictEqual(error.ownerWindowId, 9);
      assert.strictEqual(error.promptLength, "Confirm removal?".length);
      assert.notProperty(error, "promptMessage");
      assert.strictEqual(error.cause, cause);
      assert.include(error.message, "window 9");
      assert.notInclude(error.message, "Confirm removal?");
      assert.notInclude(error.message, cause.message);
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
