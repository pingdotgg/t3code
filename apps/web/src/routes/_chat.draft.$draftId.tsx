import { createFileRoute } from "@tanstack/react-router";

// The _chat layout owns ChatView so draft promotion keeps it mounted.
export const Route = createFileRoute("/_chat/draft/$draftId")({
  component: () => null,
});
