import type {
  OrchestrationV2ExplainProviderFailureResult,
  OrchestrationV2ProviderFailureClass,
} from "@t3tools/contracts";

/** Usage limits have a known cause and a dedicated recovery path, so nothing is spent explaining them. */
export function canExplainThreadError(input: {
  readonly errorClass: OrchestrationV2ProviderFailureClass | null | undefined;
  readonly hasTarget: boolean;
}): boolean {
  return input.hasTarget && input.errorClass !== "usage_limit";
}

export type ThreadErrorExplanationView =
  | { readonly kind: "idle" }
  | { readonly kind: "pending" }
  | { readonly kind: "failed"; readonly message: string }
  | {
      readonly kind: "ready";
      readonly summary: string;
      readonly likelyFix: string;
    };

/** What the banner shows for one explanation request. Nothing is asked until `requested`. */
export function deriveThreadErrorExplanationView(input: {
  readonly requested: boolean;
  readonly isPending: boolean;
  readonly data: OrchestrationV2ExplainProviderFailureResult | null;
  readonly error: string | null;
}): ThreadErrorExplanationView {
  if (!input.requested) return { kind: "idle" };
  if (input.isPending) return { kind: "pending" };
  if (input.data !== null) {
    return { kind: "ready", summary: input.data.summary, likelyFix: input.data.likelyFix };
  }
  if (input.error !== null) return { kind: "failed", message: input.error };
  return { kind: "pending" };
}
