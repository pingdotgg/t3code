import { createFileRoute } from "@tanstack/react-router";

// The view lives in the root layout (see KeptChatSurface) so a draft's
// promotion onto this route keeps the same ChatView mounted.
export const Route = createFileRoute("/_chat/$environmentId/$threadId")({
  component: () => null,
});
