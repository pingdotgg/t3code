import {
  ContextMenuItemSchema,
  DesktopAppBrandingSchema,
  DesktopEnvironmentBootstrapSchema,
  DesktopThemeSchema,
  PickFolderOptionsSchema,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as DesktopWindowIpcActions from "../../main/DesktopWindowIpcActions.ts";
import {
  CONFIRM_CHANNEL,
  CONTEXT_MENU_CHANNEL,
  GET_APP_BRANDING_CHANNEL,
  GET_LOCAL_ENVIRONMENT_BOOTSTRAP_CHANNEL,
  OPEN_EXTERNAL_CHANNEL,
  PICK_FOLDER_CHANNEL,
  SET_THEME_CHANNEL,
} from "../channels.ts";
import { makeIpcMethod, makeSyncIpcMethod } from "../DesktopIpc.ts";

const ContextMenuPosition = Schema.Struct({
  x: Schema.Number,
  y: Schema.Number,
});

const ContextMenuInput = Schema.Struct({
  items: Schema.Array(ContextMenuItemSchema),
  position: Schema.optionalKey(ContextMenuPosition),
});

export const getAppBranding = makeSyncIpcMethod({
  channel: GET_APP_BRANDING_CHANNEL,
  result: Schema.NullOr(DesktopAppBrandingSchema),
  handler: () =>
    Effect.gen(function* () {
      const window = yield* DesktopWindowIpcActions.DesktopWindowIpcActions;
      return yield* window.getAppBranding;
    }),
});

export const getLocalEnvironmentBootstrap = makeSyncIpcMethod({
  channel: GET_LOCAL_ENVIRONMENT_BOOTSTRAP_CHANNEL,
  result: Schema.NullOr(DesktopEnvironmentBootstrapSchema),
  handler: () =>
    Effect.gen(function* () {
      const window = yield* DesktopWindowIpcActions.DesktopWindowIpcActions;
      return yield* window.getLocalEnvironmentBootstrap;
    }),
});

export const pickFolder = makeIpcMethod({
  channel: PICK_FOLDER_CHANNEL,
  payload: Schema.UndefinedOr(PickFolderOptionsSchema),
  result: Schema.NullOr(Schema.String),
  handler: (options) =>
    Effect.gen(function* () {
      const window = yield* DesktopWindowIpcActions.DesktopWindowIpcActions;
      return yield* window.pickFolder(options);
    }),
});

export const confirm = makeIpcMethod({
  channel: CONFIRM_CHANNEL,
  payload: Schema.String,
  result: Schema.Boolean,
  handler: (message) =>
    Effect.gen(function* () {
      const window = yield* DesktopWindowIpcActions.DesktopWindowIpcActions;
      return yield* window.confirm(message);
    }),
});

export const setTheme = makeIpcMethod({
  channel: SET_THEME_CHANNEL,
  payload: DesktopThemeSchema,
  result: Schema.Void,
  handler: (theme) =>
    Effect.gen(function* () {
      const window = yield* DesktopWindowIpcActions.DesktopWindowIpcActions;
      yield* window.setTheme(theme);
    }),
});

export const showContextMenu = makeIpcMethod({
  channel: CONTEXT_MENU_CHANNEL,
  payload: ContextMenuInput,
  result: Schema.NullOr(Schema.String),
  handler: (input) =>
    Effect.gen(function* () {
      const window = yield* DesktopWindowIpcActions.DesktopWindowIpcActions;
      return yield* window.showContextMenu(input);
    }),
});

export const openExternal = makeIpcMethod({
  channel: OPEN_EXTERNAL_CHANNEL,
  payload: Schema.String,
  result: Schema.Boolean,
  handler: (url) =>
    Effect.gen(function* () {
      const window = yield* DesktopWindowIpcActions.DesktopWindowIpcActions;
      return yield* window.openExternal(url);
    }),
});

export const windowInvokeMethods = [
  pickFolder,
  confirm,
  setTheme,
  showContextMenu,
  openExternal,
] as const;

export const windowSyncMethods = [getAppBranding, getLocalEnvironmentBootstrap] as const;
