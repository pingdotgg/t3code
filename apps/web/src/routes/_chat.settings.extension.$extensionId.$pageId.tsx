import { createFileRoute } from "@tanstack/react-router";
import { ExtensionSettingsPage } from "../components/settings/ExtensionSettingsPage";
export const Route = createFileRoute("/_chat/settings/extension/$extensionId/$pageId")({
  component: Page,
});
function Page() {
  const { extensionId, pageId } = Route.useParams();
  return <ExtensionSettingsPage extensionId={extensionId} pageId={pageId} />;
}
