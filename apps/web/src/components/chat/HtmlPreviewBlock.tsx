import { CheckIcon, Code2Icon, CopyIcon, EyeIcon, EyeOffIcon, Maximize2Icon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";

const HTML_PREVIEW_LANGUAGES = new Set(["t3-html-preview", "html-preview", "preview-html"]);
const HTML_PREVIEW_DEFAULT_HEIGHT = 320;
const HTML_PREVIEW_MIN_HEIGHT = 120;
const HTML_PREVIEW_MAX_HEIGHT = 640;
const HTML_PREVIEW_MAX_SOURCE_CHARS = 200_000;
const HTML_PREVIEW_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src data: blob:",
  "font-src data:",
  "media-src data: blob:",
  "connect-src 'none'",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

interface HtmlPreviewOptions {
  title: string;
  initialCollapsed: boolean;
  height: number;
}

interface HtmlPreviewBlockProps {
  code: string;
  meta: string | undefined;
  isStreaming: boolean;
}

export function isHtmlPreviewLanguage(language: string): boolean {
  return HTML_PREVIEW_LANGUAGES.has(language);
}

function parseHtmlPreviewOptions(meta: string | undefined): HtmlPreviewOptions {
  const tokens = parseFenceMetaTokens(meta ?? "");
  const title = tokens.get("title")?.trim() || "HTML preview";
  const requestedHeight = Number(tokens.get("height") ?? "");
  const height = Number.isFinite(requestedHeight)
    ? Math.min(
        HTML_PREVIEW_MAX_HEIGHT,
        Math.max(HTML_PREVIEW_MIN_HEIGHT, Math.round(requestedHeight)),
      )
    : HTML_PREVIEW_DEFAULT_HEIGHT;

  return {
    title,
    initialCollapsed:
      tokens.has("collapsed") ||
      tokens.has("hidden") ||
      tokens.get("open") === "false" ||
      tokens.get("expanded") === "false",
    height,
  };
}

function parseFenceMetaTokens(meta: string): Map<string, string> {
  const tokens = new Map<string, string>();
  const pattern =
    /([a-zA-Z][\w-]*)(?:=(?:"([^"]*)"|'([^']*)'|([^\s"']+)))?|(?:"([^"]*)"|'([^']*)'|([^\s"']+))/g;
  let positionalIndex = 0;

  for (const match of meta.matchAll(pattern)) {
    const key = match[1];
    if (key) {
      tokens.set(key.toLowerCase(), match[2] ?? match[3] ?? match[4] ?? "true");
      continue;
    }

    const positional = match[5] ?? match[6] ?? match[7];
    if (positional) {
      tokens.set(`_${positionalIndex}`, positional);
      positionalIndex += 1;
    }
  }

  return tokens;
}

function buildHtmlPreviewSrcDoc(html: string): string {
  const cspMeta = `<meta http-equiv="Content-Security-Policy" content="${HTML_PREVIEW_CSP}">`;
  const viewportMeta = `<meta name="viewport" content="width=device-width, initial-scale=1">`;
  const baseStyles = `<style>html,body{margin:0;min-height:100%;}body{box-sizing:border-box;font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;}*,*::before,*::after{box-sizing:inherit;}</style>`;
  const headContent = `${cspMeta}${viewportMeta}${baseStyles}`;

  if (/<html[\s>]/i.test(html)) {
    if (/<head[\s>]/i.test(html)) {
      return html.replace(/<head([^>]*)>/i, `<head$1>${headContent}`);
    }
    return html.replace(/<html([^>]*)>/i, `<html$1><head>${headContent}</head>`);
  }

  return `<!doctype html><html><head>${headContent}</head><body>${html}</body></html>`;
}

export function HtmlPreviewBlock({ code, meta, isStreaming }: HtmlPreviewBlockProps) {
  const options = useMemo(() => parseHtmlPreviewOptions(meta), [meta]);
  const [collapsed, setCollapsed] = useState(options.initialCollapsed);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sourceTooLarge = code.length > HTML_PREVIEW_MAX_SOURCE_CHARS;
  const srcDoc = useMemo(
    () => (sourceTooLarge ? "" : buildHtmlPreviewSrcDoc(code)),
    [code, sourceTooLarge],
  );

  useEffect(() => {
    setCollapsed(options.initialCollapsed);
  }, [code, options.initialCollapsed]);

  useEffect(
    () => () => {
      if (copiedTimerRef.current != null) {
        clearTimeout(copiedTimerRef.current);
        copiedTimerRef.current = null;
      }
    },
    [],
  );

  const handleCopy = useCallback(() => {
    if (typeof navigator === "undefined" || navigator.clipboard == null) {
      return;
    }

    void navigator.clipboard
      .writeText(code)
      .then(() => {
        if (copiedTimerRef.current != null) {
          clearTimeout(copiedTimerRef.current);
        }
        setCopied(true);
        copiedTimerRef.current = setTimeout(() => {
          setCopied(false);
          copiedTimerRef.current = null;
        }, 1200);
      })
      .catch(() => undefined);
  }, [code]);

  return (
    <div className="my-3 overflow-hidden rounded-lg border border-border bg-background">
      <div className="flex min-h-10 items-center justify-between gap-3 border-b border-border bg-muted/45 px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <Code2Icon className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate text-xs font-medium text-foreground">{options.title}</span>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            onClick={handleCopy}
            title={copied ? "Copied" : "Copy HTML"}
            aria-label={copied ? "Copied" : "Copy HTML"}
          >
            {copied ? <CheckIcon className="size-3.5" /> : <CopyIcon className="size-3.5" />}
          </Button>
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            disabled={sourceTooLarge || isStreaming}
            onClick={() => setDialogOpen(true)}
            title="Maximize preview"
            aria-label="Maximize preview"
          >
            <Maximize2Icon className="size-3.5" />
          </Button>
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            onClick={() => setCollapsed((value) => !value)}
            title={collapsed ? "Show preview" : "Hide preview"}
            aria-label={collapsed ? "Show preview" : "Hide preview"}
          >
            {collapsed ? <EyeIcon className="size-3.5" /> : <EyeOffIcon className="size-3.5" />}
          </Button>
        </div>
      </div>

      {collapsed ? (
        <div className="px-3 py-2 text-xs text-muted-foreground">Preview hidden</div>
      ) : sourceTooLarge ? (
        <div className="px-3 py-2 text-xs text-muted-foreground">
          Preview source exceeds the inline render limit.
        </div>
      ) : isStreaming ? (
        <div className="px-3 py-2 text-xs text-muted-foreground">
          Preview renders when the response finishes.
        </div>
      ) : (
        <iframe
          title={`${options.title} preview`}
          srcDoc={srcDoc}
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          loading="lazy"
          className="block w-full border-0 bg-white"
          style={{ height: options.height }}
        />
      )}

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogPopup
          className="max-h-[92dvh] max-w-6xl overflow-hidden"
          bottomStickOnMobile={false}
        >
          <DialogHeader>
            <DialogTitle>{options.title}</DialogTitle>
            <DialogDescription>Sandboxed HTML preview</DialogDescription>
          </DialogHeader>
          <DialogPanel className="p-0" scrollFade={false}>
            {!sourceTooLarge && !isStreaming ? (
              <iframe
                title={`${options.title} maximized preview`}
                srcDoc={srcDoc}
                sandbox="allow-scripts"
                referrerPolicy="no-referrer"
                className="block h-[72dvh] w-full border-0 bg-white"
              />
            ) : (
              <div className="px-6 py-4 text-sm text-muted-foreground">
                Preview is not available for this source yet.
              </div>
            )}
          </DialogPanel>
        </DialogPopup>
      </Dialog>
    </div>
  );
}
