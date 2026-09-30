/**
 * nativeID for in-window UI that handles Android back in JS. While a view with
 * this ID is on screen, withAndroidNativeScreenBack hands back to JS instead of
 * popping the screen natively, so back closes that UI first.
 */
export const JS_BACK_HANDLER_NATIVE_ID = "t3-js-back-handler";
