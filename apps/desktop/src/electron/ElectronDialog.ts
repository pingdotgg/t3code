import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as Electron from "electron";

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
