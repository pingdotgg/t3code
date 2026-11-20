import { httpPageUrl } from "@t3tools/contracts";
import { MCP_URL_ELICITATION_HINT } from "@t3tools/client-runtime/state/thread-requests";
import { ExternalLinkIcon } from "lucide-react";
import { T, useGT, useMessages } from "gt-react";
import { useState } from "react";
import { ensureLocalApi } from "../../localApi";
import { InlineButton } from "../ui/button";

export function McpElicitationLink({ url, disabled }: { url: string; disabled: boolean }) {
  const gt = useGT();
  const m = useMessages();
  const page = httpPageUrl(url);
  const [error, setError] = useState(false);
  if (!page) return null;
  return (
    <div className="flex min-w-0 flex-col items-start gap-1">
      <span className="text-muted-foreground">{m(MCP_URL_ELICITATION_HINT)}</span>
      <span className="font-mono text-xs text-muted-foreground select-text wrap-anywhere">
        {page.href}
      </span>
      <InlineButton
        disabled={disabled}
        render={
          !window.desktopBridge && !disabled ? (
            <a href={page.href} target="_blank" rel="noopener noreferrer" />
          ) : undefined
        }
        onClick={() => {
          if (!window.desktopBridge) return;
          setError(false);
          void ensureLocalApi()
            .shell.openExternal(page.href)
            .catch(() => setError(true));
        }}
      >
        {gt("Open {host}", { host: page.host })}
        <ExternalLinkIcon aria-hidden className="size-3" />
      </InlineButton>
      {error ? (
        <span role="alert" className="text-destructive">
          <T>Could not open the link. Copy it into your browser to continue.</T>
        </span>
      ) : null}
    </div>
  );
}
