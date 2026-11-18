import { type EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";
import type { EnvironmentThreadStatus } from "@t3tools/client-runtime/state/threads";
import { msg } from "gt-react-native";

import { m, type MessageResolver } from "../../i18n/messages";

export type ThreadContentPresentation =
  | { readonly kind: "ready" }
  | { readonly kind: "loading" }
  | {
      readonly kind: "unavailable";
      readonly title: string;
      readonly detail: string;
    };

export function projectThreadContentPresentation(input: {
  readonly hasDetail: boolean;
  readonly detailError: string | null;
  readonly detailDeleted: boolean;
  readonly connectionState: EnvironmentConnectionPhase;
  readonly resolve?: MessageResolver;
}): ThreadContentPresentation {
  const resolve = input.resolve ?? m;
  if (input.hasDetail) {
    return { kind: "ready" };
  }
  if (input.detailDeleted) {
    return {
      kind: "unavailable",
      title: resolve(msg("Thread unavailable")),
      detail: resolve(msg("This thread was deleted or is no longer available.")),
    };
  }
  if (input.detailError !== null) {
    return {
      kind: "unavailable",
      title: resolve(msg("Could not load conversation")),
      detail: input.detailError,
    };
  }
  if (
    input.connectionState === "connected" ||
    input.connectionState === "connecting" ||
    input.connectionState === "reconnecting"
  ) {
    return { kind: "loading" };
  }
  return {
    kind: "unavailable",
    title: resolve(msg("Messages not cached")),
    detail: resolve(msg("Reconnect this environment to load the conversation.")),
  };
}

export function threadSyncStatusLabel(
  status: EnvironmentThreadStatus,
  presentation: ThreadContentPresentation["kind"],
  resolve: MessageResolver = m,
): string | null {
  if (status !== "empty" && status !== "cached" && status !== "synchronizing") return null;
  if (presentation === "ready") return resolve(msg("Syncing messages…"));
  return presentation === "loading" ? resolve(msg("Loading messages…")) : null;
}
