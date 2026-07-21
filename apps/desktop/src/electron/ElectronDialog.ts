// @effect-diagnostics nodeBuiltinImport:off - Electron's native picker returns host paths.
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as NodePath from "node:path";

import * as Electron from "electron";
import type { DesktopApplicationSelection } from "@t3tools/contracts";

import { resolveMacApplicationIconDataUrl } from "./MacApplicationIcon.ts";

const CONFIRM_BUTTON_INDEX = 1;

export class ElectronDialogPickFolderError extends Schema.TaggedErrorClass<ElectronDialogPickFolderError>()(
  "ElectronDialogPickFolderError",
  {
    ownerWindowId: Schema.NullOr(Schema.Number),
    defaultPath: Schema.NullOr(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    const owner = this.ownerWindowId === null ? "the application" : `window ${this.ownerWindowId}`;
    const defaultPath = this.defaultPath === null ? "no default path" : this.defaultPath;
    return `Failed to open the Electron folder picker for ${owner} with ${defaultPath}.`;
  }
}

export class ElectronDialogPickApplicationError extends Schema.TaggedErrorClass<ElectronDialogPickApplicationError>()(
  "ElectronDialogPickApplicationError",
  {
    ownerWindowId: Schema.NullOr(Schema.Number),
    selectedPath: Schema.NullOr(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Failed to select a macOS application.";
  }
}

export class ElectronDialogConfirmError extends Schema.TaggedErrorClass<ElectronDialogConfirmError>()(
  "ElectronDialogConfirmError",
  {
    ownerWindowId: Schema.NullOr(Schema.Number),
    promptLength: Schema.Number,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    const owner = this.ownerWindowId === null ? "the application" : `window ${this.ownerWindowId}`;
    return `Failed to open an Electron confirmation dialog for ${owner} with a ${this.promptLength}-character prompt.`;
  }
}

export class ElectronDialogShowMessageBoxError extends Schema.TaggedErrorClass<ElectronDialogShowMessageBoxError>()(
  "ElectronDialogShowMessageBoxError",
  {
    type: Schema.NullOr(Schema.Literals(["none", "info", "error", "question", "warning"])),
    titleLength: Schema.NullOr(Schema.Number),
    messageLength: Schema.Number,
    detailLength: Schema.NullOr(Schema.Number),
    buttonCount: Schema.Number,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    const type = this.type === null ? "untyped" : this.type;
    return `Failed to show the Electron ${type} message box with ${this.buttonCount} buttons.`;
  }
}

export class ElectronDialogShowErrorBoxError extends Schema.TaggedErrorClass<ElectronDialogShowErrorBoxError>()(
  "ElectronDialogShowErrorBoxError",
  {
    titleLength: Schema.Number,
    contentLength: Schema.Number,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to show the Electron error box with a ${this.titleLength}-character title and ${this.contentLength}-character content.`;
  }
}

export const ElectronDialogError = Schema.Union([
  ElectronDialogPickFolderError,
  ElectronDialogPickApplicationError,
  ElectronDialogConfirmError,
  ElectronDialogShowMessageBoxError,
  ElectronDialogShowErrorBoxError,
]);
export type ElectronDialogError = typeof ElectronDialogError.Type;
export const isElectronDialogError = Schema.is(ElectronDialogError);

export interface ElectronDialogPickFolderInput {
  readonly owner: Option.Option<Electron.BrowserWindow>;
  readonly defaultPath: Option.Option<string>;
}

export interface ElectronDialogPickApplicationInput {
  readonly owner: Option.Option<Electron.BrowserWindow>;
}

export interface ElectronDialogConfirmInput {
  readonly owner: Option.Option<Electron.BrowserWindow>;
  readonly message: string;
}

export class ElectronDialog extends Context.Service<
  ElectronDialog,
  {
    readonly pickFolder: (
      input: ElectronDialogPickFolderInput,
    ) => Effect.Effect<Option.Option<string>, ElectronDialogPickFolderError>;
    readonly pickApplication: (
      input: ElectronDialogPickApplicationInput,
    ) => Effect.Effect<
      Option.Option<DesktopApplicationSelection>,
      ElectronDialogPickApplicationError
    >;
    readonly confirm: (
      input: ElectronDialogConfirmInput,
    ) => Effect.Effect<boolean, ElectronDialogConfirmError>;
    readonly showMessageBox: (
      options: Electron.MessageBoxOptions,
    ) => Effect.Effect<Electron.MessageBoxReturnValue, ElectronDialogShowMessageBoxError>;
    readonly showErrorBox: (title: string, content: string) => Effect.Effect<void>;
  }
>()("@t3tools/desktop/electron/ElectronDialog") {}

export const make = ElectronDialog.of({
  pickFolder: Effect.fn("desktop.electron.dialog.pickFolder")(function* (input) {
    const ownerWindowId = Option.match(input.owner, {
      onNone: () => null,
      onSome: (owner) => owner.id,
    });
    const defaultPath = Option.getOrNull(input.defaultPath);
    const openDialogOptions: Electron.OpenDialogOptions = Option.match(input.defaultPath, {
      onNone: () => ({
        properties: ["openDirectory", "createDirectory"],
      }),
      onSome: (defaultPath) => ({
        properties: ["openDirectory", "createDirectory"],
        defaultPath,
      }),
    });
    const result = yield* Effect.tryPromise({
      try: () =>
        Option.match(input.owner, {
          onNone: () => Electron.dialog.showOpenDialog(openDialogOptions),
          onSome: (owner) => Electron.dialog.showOpenDialog(owner, openDialogOptions),
        }),
      catch: (cause) =>
        new ElectronDialogPickFolderError({
          ownerWindowId,
          defaultPath,
          cause,
        }),
    });

    if (result.canceled) {
      return Option.none();
    }
    return Option.fromNullishOr(result.filePaths[0]);
  }),
  pickApplication: Effect.fn("desktop.electron.dialog.pickApplication")(function* (input) {
    const ownerWindowId = Option.match(input.owner, {
      onNone: () => null,
      onSome: (owner) => owner.id,
    });
    const options: Electron.OpenDialogOptions = {
      defaultPath: "/Applications",
      properties: ["openFile"],
      filters: [{ name: "Applications", extensions: ["app"] }],
    };
    const result = yield* Effect.tryPromise({
      try: () =>
        Option.match(input.owner, {
          onNone: () => Electron.dialog.showOpenDialog(options),
          onSome: (owner) => Electron.dialog.showOpenDialog(owner, options),
        }),
      catch: (cause) =>
        new ElectronDialogPickApplicationError({
          ownerWindowId,
          selectedPath: null,
          cause,
        }),
    });
    if (result.canceled) return Option.none();

    const applicationPath = result.filePaths[0];
    if (
      applicationPath === undefined ||
      !NodePath.isAbsolute(applicationPath) ||
      !applicationPath.toLowerCase().endsWith(".app")
    ) {
      return yield* new ElectronDialogPickApplicationError({
        ownerWindowId,
        selectedPath: applicationPath ?? null,
        cause: new Error("The selected path is not an absolute .app bundle."),
      });
    }

    const iconDataUrl = yield* Effect.tryPromise({
      try: () => resolveMacApplicationIconDataUrl(applicationPath),
      catch: (cause) =>
        new ElectronDialogPickApplicationError({
          ownerWindowId,
          selectedPath: applicationPath,
          cause,
        }),
    }).pipe(Effect.orElseSucceed(() => null));
    return Option.some({
      applicationPath,
      suggestedName: NodePath.basename(applicationPath, NodePath.extname(applicationPath)),
      iconDataUrl,
    });
  }),
  confirm: Effect.fn("desktop.electron.dialog.confirm")(function* (input) {
    const normalizedMessage = input.message.trim();
    if (normalizedMessage.length === 0) {
      return false;
    }

    const options = {
      type: "question" as const,
      buttons: ["No", "Yes"],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
      message: normalizedMessage,
    };
    const ownerWindowId = Option.match(input.owner, {
      onNone: () => null,
      onSome: (owner) => owner.id,
    });
    const result = yield* Effect.tryPromise({
      try: () =>
        Option.match(input.owner, {
          onNone: () => Electron.dialog.showMessageBox(options),
          onSome: (owner) => Electron.dialog.showMessageBox(owner, options),
        }),
      catch: (cause) =>
        new ElectronDialogConfirmError({
          ownerWindowId,
          promptLength: normalizedMessage.length,
          cause,
        }),
    });
    return result.response === CONFIRM_BUTTON_INDEX;
  }),
  showMessageBox: (options) =>
    Effect.tryPromise({
      try: () => Electron.dialog.showMessageBox(options),
      catch: (cause) =>
        new ElectronDialogShowMessageBoxError({
          type: options.type ?? null,
          titleLength: options.title?.length ?? null,
          messageLength: options.message.length,
          detailLength: options.detail?.length ?? null,
          buttonCount: options.buttons?.length ?? 0,
          cause,
        }),
    }),
  showErrorBox: (title, content) =>
    Effect.try({
      try: () => Electron.dialog.showErrorBox(title, content),
      catch: (cause) =>
        new ElectronDialogShowErrorBoxError({
          titleLength: title.length,
          contentLength: content.length,
          cause,
        }),
    }).pipe(Effect.orDie),
});

export const layer = Layer.succeed(ElectronDialog, make);
