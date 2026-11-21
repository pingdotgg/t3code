import type { ScopedThreadRef } from "@t3tools/contracts";
import { msg, useMessages } from "gt-react";

import type { MessageResolver } from "../../i18n/messages";
import { DiscoveryListRow } from "../ui/discovery-list";

import { PreviewFaviconIcon } from "./PreviewFaviconIcon";
import type { PreviewableServer } from "./useDiscoveredLocalServers";
import { definePluginComponent } from "~/plugins/features";

export const PreviewLocalServerCard = definePluginComponent(
  "component:components/preview/PreviewLocalServerCard/PreviewLocalServerCard",
  PluginOriginalPreviewLocalServerCard,
);

interface Props {
  threadRef: ScopedThreadRef;
  server: PreviewableServer;
  onOpen: () => void;
}

function PluginOriginalPreviewLocalServerCard({ threadRef, server, onOpen }: Props) {
  const m = useMessages();
  const subtitle = describeServer(server, m);
  return (
    <DiscoveryListRow
      onClick={onOpen}
      icon={<PreviewFaviconIcon threadRef={threadRef} url={server.requestedUrl} />}
      title={subtitle}
      description={`${server.host}:${server.port}`}
    />
  );
}

function describeServer(server: PreviewableServer, resolve: MessageResolver): string {
  if (server.processName) return server.processName;
  return resolve(msg("Listening", { $context: "a local server is listening on a port" }));
}
