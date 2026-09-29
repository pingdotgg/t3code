import { type EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";

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
}): ThreadContentPresentation {
  if (input.hasDetail) {
    return { kind: "ready" };
  }
  if (input.detailDeleted) {
    return {
      kind: "unavailable",
      title: translate("common:mobileThreadUnavailable", "Thread unavailable"),
      detail: translate(
        "common:mobileFeedback.threadDeletedOrUnavailable",
        "This thread was deleted or is no longer available.",
      ),
    };
  }
  if (input.detailError !== null) {
    return {
      kind: "unavailable",
      title: translate(
        "common:mobileFeedback.couldNotLoadConversation",
        "Could not load conversation",
      ),
      detail: input.detailError,
    };
  }
  if (
    input.connectionState === "connected" ||
    input.connectionState === "connecting" ||
    input.connectionState === "reconnecting"
  ) {
    // Messages will arrive once the (re)connection completes — present as
    // loading; the composer's connection pill reports the connection phase.
    return { kind: "loading" };
  }
  return {
    kind: "unavailable",
    title: translate("common:mobileFeedback.messagesNotCached", "Messages not cached"),
    detail: translate(
      "common:mobileFeedback.reconnectToLoadConversation",
      "Reconnect this environment to load the conversation.",
    ),
  };
}
import { translate } from "@t3tools/i18n";
