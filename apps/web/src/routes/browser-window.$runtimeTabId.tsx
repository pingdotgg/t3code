import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { type EnvironmentId, ThreadId } from "@t3tools/contracts";
import { createFileRoute } from "@tanstack/react-router";

import { PreviewPanel } from "~/components/preview/PreviewPanel";
import { usePreviewSession } from "~/components/preview/usePreviewSession";

export const Route = createFileRoute("/browser-window/$runtimeTabId")({
  component: BrowserWindowRoute,
});

function BrowserWindowRoute() {
  const { runtimeTabId } = Route.useParams();
  const [environmentId, threadId, , tabId] = JSON.parse(runtimeTabId) as [
    string,
    string,
    string | null,
    string,
  ];
  const threadRef = scopeThreadRef(environmentId as EnvironmentId, ThreadId.make(threadId));
  usePreviewSession(threadRef);
  return (
    <div className="flex h-dvh flex-col">
      <PreviewPanel mode="embedded" threadRef={threadRef} tabId={tabId} visible />
    </div>
  );
}
