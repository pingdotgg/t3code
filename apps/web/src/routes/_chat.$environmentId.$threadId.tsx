import { createFileRoute } from "@tanstack/react-router";

// The view lives in the `_chat` layout (see ThreadRouteView) so a draft's
// promotion onto this route keeps the same ChatView mounted.
export const Route = createFileRoute("/_chat/$environmentId/$threadId")({
  component: () => null,
});
