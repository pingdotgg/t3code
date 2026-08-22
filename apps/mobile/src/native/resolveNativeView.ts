import type { ComponentType } from "react";
import { requireNativeView } from "expo";

import { NativeViewResolutionError } from "./nativeViewResolutionError";

/**
 * Resolves an Expo view that may be missing from the installed binary, which happens whenever a
 * JavaScript update lands ahead of the native build that registers the view. The returned function
 * memoizes a resolved component and a hard resolution failure, but keeps re-probing while the view
 * is merely unregistered, so a call made before the registry fills does not poison the cache.
 * Callers can invoke it during render and fall back to an upgrade message when it yields `null`.
 */
export function createNativeViewResolver<Props>(nativeModuleName: string) {
  // `undefined` means unresolved; `null` means resolution was attempted and failed.
  let cached: ComponentType<Props> | null | undefined;

  return (): ComponentType<Props> | null => {
    if (cached !== undefined) {
      return cached;
    }

    if (globalThis.expo?.getViewConfig?.(nativeModuleName) == null) {
      return null;
    }

    try {
      cached = requireNativeView<Props>(nativeModuleName);
    } catch (cause) {
      cached = null;
      console.error(new NativeViewResolutionError({ nativeModuleName, cause }));
    }

    return cached;
  };
}
