import { createFileRoute } from "@tanstack/react-router";

// The view lives in the `_chat` layout (see ThreadRouteView) so a draft's
// promotion to `/$environmentId/$threadId` keeps the same ChatView mounted.
export const Route = createFileRoute("/_chat/draft/$draftId")({
  component: () => null,
});
