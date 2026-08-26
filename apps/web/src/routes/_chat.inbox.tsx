import { createFileRoute } from "@tanstack/react-router";

import { InboxPage } from "../components/inbox/InboxPage";

export const Route = createFileRoute("/_chat/inbox")({
  component: () => <InboxPage view="inbox" />,
});
