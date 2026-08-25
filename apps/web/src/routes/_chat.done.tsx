import { createFileRoute } from "@tanstack/react-router";

import { InboxPage } from "../components/inbox/InboxPage";

export const Route = createFileRoute("/_chat/done")({
  component: () => <InboxPage view="done" />,
});
