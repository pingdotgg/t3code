export type ReviewHighlighterEnginePreference = "auto" | "javascript" | "native";
export type ReviewHighlighterEngine = "javascript" | "native";

export function resolveReviewHighlighterEnginePreference(
  value: string | undefined,
): ReviewHighlighterEnginePreference {
  switch (value) {
    case "javascript":
    case "native":
    case "auto":
      return value;
    default:
      return "auto";
  }
}

export function resolveReviewHighlighterEngine(
  preference: ReviewHighlighterEnginePreference,
  nativeAvailable: boolean,
): ReviewHighlighterEngine {
  if (preference === "javascript") {
    return "javascript";
  }

  if (nativeAvailable) {
    return "native";
  }

  return "javascript";
}

export function hasTurboModuleProxy(): boolean {
  const turboModuleProxy = (globalThis as { readonly __turboModuleProxy?: unknown })
    .__turboModuleProxy;
  return typeof turboModuleProxy === "function";
}
