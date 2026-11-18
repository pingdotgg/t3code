import { msg, T, useGT, useMessages, Var } from "gt-react";
import { Dot, ExternalLink, FileDown, RotateCw, Unplug } from "lucide-react";

import { Button } from "~/components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";

import { describePreviewError } from "./errorCodeMessages";

interface Props {
  url: string;
  code: number;
  description: string;
  onReload: () => void;
  /** Hands the URL to the system browser; omitted where there is no shell. */
  onOpenInBrowser?: (() => void) | undefined;
  move?: { readonly label: string; readonly onMove: () => void };
}

const SUGGESTIONS = [
  msg("Confirming the dev server is running"),
  msg("Checking the proxy and the firewall"),
  msg("Checking your connection"),
] as const;

const MOVE_SUGGESTION = msg("Opening it in the environment’s browser, which reaches its network");

export function PreviewFileNotShown({
  url,
  fileName,
  downloadUrl,
  onOpen,
}: {
  url: string;
  fileName: string;
  downloadUrl: string | null;
  onOpen: () => void;
}) {
  const host = safeHost(url) ?? url;
  return (
    <div className="scrollbar-gutter-both relative flex h-full min-h-0 w-full overflow-y-auto bg-background">
      <div className="mx-auto flex w-full max-w-xl flex-col items-center gap-3.5 px-8 py-12 text-center">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-full surface-raised">
          <FileDown aria-hidden className="size-4.5 text-muted-foreground" />
        </span>
        <h1 className="max-w-full break-words text-label text-foreground">
          <T>This file can&rsquo;t be shown here</T>
        </h1>
        <p className="max-w-full break-words text-body text-muted-foreground">
          <T>
            <Var>{fileName}</Var> from <Var>{host}</Var> was downloaded instead.
          </T>
        </p>
        <div className="flex flex-wrap items-center justify-center gap-2">
          <Button type="button" variant="secondary" size="sm" onClick={onOpen}>
            <ExternalLink />
            <T>Open in browser</T>
          </Button>
          {downloadUrl ? (
            <Button type="button" size="sm" render={<a href={downloadUrl} download={fileName} />}>
              <T context="verb">Download</T>
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/**
 * Shown over the webview when a page fails to load. The friendly reason and the
 * raw net error code live in the title's tooltip.
 */
export function PreviewUnreachable({
  url,
  code,
  description,
  onReload,
  onOpenInBrowser,
  move,
}: Props) {
  const gt = useGT();
  const m = useMessages();
  const host = safeHost(url) ?? url;
  const friendly = describePreviewError(description, m);
  const errorLabel = description.length > 0 ? description : `ERR_${Math.abs(code) || "FAILED"}`;
  const suggestions = move ? [...SUGGESTIONS, MOVE_SUGGESTION] : SUGGESTIONS;

  return (
    <div className="scrollbar-gutter-both relative flex h-full min-h-0 w-full overflow-y-auto bg-background">
      <div className="mx-auto flex w-full max-w-xl flex-col items-center gap-3.5 px-8 py-12 text-center">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-full surface-raised">
          <Unplug aria-hidden className="size-4.5 text-muted-foreground" />
        </span>
        <Tooltip>
          <TooltipTrigger
            render={
              <h1
                tabIndex={0}
                className="max-w-full break-words text-label text-foreground outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
              />
            }
          >
            {gt("{host} isn’t responding", { host })}
          </TooltipTrigger>
          <TooltipPopup side="bottom">
            <span className="flex flex-col gap-0.5">
              <span>{friendly}</span>
              <span>{errorLabel}</span>
            </span>
          </TooltipPopup>
        </Tooltip>
        <div className="flex w-[300px] max-w-full flex-col gap-2 rounded-card surface-card-settings px-3.5 py-3 text-left">
          <p className="text-meta text-muted-foreground">
            <T>Try:</T>
          </p>
          <ul className="flex flex-col gap-2">
            {suggestions.map((suggestion) => (
              <li key={suggestion} className="flex items-center gap-2 text-body text-foreground">
                <Dot aria-hidden className="size-3.5 shrink-0 text-dim-foreground" />
                {m(suggestion)}
              </li>
            ))}
          </ul>
        </div>
        <div className="flex flex-wrap items-center justify-center gap-2">
          {onOpenInBrowser ? (
            <Button type="button" variant="secondary" size="sm" onClick={onOpenInBrowser}>
              <ExternalLink />
              <T>Open in system browser</T>
            </Button>
          ) : null}
          {move ? (
            <Button type="button" variant="secondary" size="sm" onClick={move.onMove}>
              {move.label}
            </Button>
          ) : null}
          <Button type="button" size="sm" onClick={onReload}>
            <RotateCw />
            <T>Retry</T>
          </Button>
        </div>
      </div>
    </div>
  );
}

function safeHost(url: string): string | null {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}
