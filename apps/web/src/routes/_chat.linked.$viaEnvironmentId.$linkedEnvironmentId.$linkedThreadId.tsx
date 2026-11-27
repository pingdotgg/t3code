import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { createFileRoute } from "@tanstack/react-router";

import { LinkedThreadPage } from "../components/chat/LinkedThreadPage";

// A thread on a linked environment this client is not connected to, read through `viaEnvironmentId`.
// Its params are not named `environmentId` and `threadId`: those mean a thread this client can open.
export const Route = createFileRoute(
  "/_chat/linked/$viaEnvironmentId/$linkedEnvironmentId/$linkedThreadId",
)({
  component: function LinkedThreadRoute() {
    const params = Route.useParams();
    return (
      <LinkedThreadPage
        viaEnvironmentId={EnvironmentId.make(params.viaEnvironmentId)}
        environmentId={EnvironmentId.make(params.linkedEnvironmentId)}
        threadId={ThreadId.make(params.linkedThreadId)}
      />
    );
  },
});
