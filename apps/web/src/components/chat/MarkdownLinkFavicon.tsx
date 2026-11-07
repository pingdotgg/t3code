import { faviconUrlForOrigin } from "@t3tools/shared/favicon";
import { GlobeIcon } from "lucide-react";
import { memo, useState, type ReactNode } from "react";

import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";

import { cn } from "~/lib/utils";
import { sourceControlIcon } from "../../sourceControlPresentation";

const MARKDOWN_LINK_FAVICON_CLASS_NAME = "block size-full shrink-0 select-none";

const failedFaviconHosts = new Set<string>();

function sourceControlHostIcon(host: string): ReactNode {
  const definition = sourceControlClients.findByPublicDomain(host);
  if (definition === undefined) return null;
  const Icon = sourceControlIcon(definition);
  return <Icon className={MARKDOWN_LINK_FAVICON_CLASS_NAME} />;
}

export const MarkdownLinkFavicon = memo(function MarkdownLinkFavicon({ host }: { host: string }) {
  const [failedHost, setFailedHost] = useState<string | null>(null);
  const brandIcon = sourceControlHostIcon(host);
  const faviconUrl = brandIcon ? null : faviconUrlForOrigin(`https://${host}`);
  return (
    <span
      className="ms-[0.25em] me-[0.2em] inline-flex size-[14px] [vertical-align:-0.125em]"
      aria-hidden
    >
      {brandIcon ? (
        brandIcon
      ) : faviconUrl === null || failedHost === host || failedFaviconHosts.has(host) ? (
        <GlobeIcon className={MARKDOWN_LINK_FAVICON_CLASS_NAME} />
      ) : (
        <img
          src={faviconUrl}
          alt=""
          loading="lazy"
          draggable={false}
          className={cn(MARKDOWN_LINK_FAVICON_CLASS_NAME, "rounded-sm")}
          onError={() => {
            failedFaviconHosts.add(host);
            setFailedHost(host);
          }}
        />
      )}
    </span>
  );
});
