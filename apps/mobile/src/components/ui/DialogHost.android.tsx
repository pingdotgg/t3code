export { Host as DialogHost } from "./Dialog.android";

/** Compose dialogs open in their own window, so sheets need no extra host on Android. */
export function DialogSheetHost() {
  return null;
}
