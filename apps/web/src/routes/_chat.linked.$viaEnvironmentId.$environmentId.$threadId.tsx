import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { createFileRoute } from "@tanstack/react-router";

import { LinkedThreadPage } from "../components/chat/LinkedThreadPage";

// A thread on a linked environment this client is not connected to, read through `viaEnvironmentId`.
export const Route = createFileRoute("/_chat/linked/$viaEnvironmentId/$environmentId/$threadId")({
  component: function LinkedThreadRoute() {
    const params = Route.useParams();
    return (
      <LinkedThreadPage
        viaEnvironmentId={EnvironmentId.make(params.viaEnvironmentId)}
        environmentId={EnvironmentId.make(params.environmentId)}
        threadId={ThreadId.make(params.threadId)}
      />
    );
  },
});
