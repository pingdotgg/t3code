import { faviconUrlForOrigin } from "@t3tools/shared/favicon";
import { GlobeIcon } from "lucide-react";
import { Globe, createElement } from "lucide";
import { Children, memo, useState, type ReactNode } from "react";

import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";

import { cn } from "../../lib/utils";
import { sourceControlIcon } from "../../sourceControlPresentation";

const MARKDOWN_LINK_FAVICON_CLASS_NAME = "block size-full shrink-0 select-none";

const failedFaviconHosts = new Set<string>();

function sourceControlHostIcon(host: string): ReactNode {
  const definition = sourceControlClients.findByPublicDomain(host);
  if (definition === undefined) return null;
  const Icon = sourceControlIcon(definition);
  return <Icon className={MARKDOWN_LINK_FAVICON_CLASS_NAME} />;
}

const MarkdownLinkFavicon = memo(function MarkdownLinkFavicon({ host }: { host: string }) {
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

function leadingExternalLinkTextLength(text: string): number {
  const protocol = /^(?:https?:\/\/)/i.exec(text)?.[0];
  if (protocol) return protocol.length;
  return Math.min(text.length, 1);
}

export function createLiveExternalLinkContent(host: string, text: string): DocumentFragment | null {
  if (sourceControlClients.findByPublicDomain(host)) return null;
  const result = document.createDocumentFragment();
  const leading = document.createElement("span");
  leading.className = "whitespace-nowrap";
  const icon = document.createElement("span");
  icon.className = "ms-[0.25em] me-[0.2em] inline-flex size-[14px] [vertical-align:-0.125em]";
  icon.setAttribute("aria-hidden", "true");
  const globe = () =>
    createElement(Globe, {
      class: `lucide lucide-globe ${MARKDOWN_LINK_FAVICON_CLASS_NAME}`,
      "aria-hidden": "true",
    });
  const favicon = failedFaviconHosts.has(host) ? null : faviconUrlForOrigin(`https://${host}`);
  if (favicon) {
    const image = document.createElement("img");
    image.src = favicon;
    image.alt = "";
    image.loading = "lazy";
    image.draggable = false;
    image.className = `${MARKDOWN_LINK_FAVICON_CLASS_NAME} rounded-sm`;
    image.addEventListener(
      "error",
      () => {
        failedFaviconHosts.add(host);
        icon.replaceChildren(globe());
      },
      { once: true },
    );
    icon.append(image);
  } else icon.append(globe());
  const length = leadingExternalLinkTextLength(text);
  leading.append(icon, text.slice(0, length));
  result.append(leading);
  for (const word of text.slice(length).match(/\s+|\S+/g) ?? []) {
    if (word.length <= 16) result.append(word);
    else {
      const span = document.createElement("span");
      span.className = "[overflow-wrap:anywhere]";
      span.textContent = word;
      result.append(span);
    }
  }
  return result;
}

// Keep short labels such as PR numbers intact in narrow table columns.
function breakableExternalLinkText(text: string): ReactNode[] {
  return Array.from(text.matchAll(/\s+|\S+/g), ({ 0: word, index: start }) =>
    word.length <= 16 ? (
      word
    ) : (
      <span key={start} className="[overflow-wrap:anywhere]">
        {word}
      </span>
    ),
  );
}

export function MarkdownExternalLinkContent({
  host,
  plainText,
  children,
}: {
  host: string;
  plainText: string | null;
  children: ReactNode;
}) {
  if (plainText) {
    const leadingLength = leadingExternalLinkTextLength(plainText);
    return (
      <>
        <span className="whitespace-nowrap">
          <MarkdownLinkFavicon host={host} />
          {plainText.slice(0, leadingLength)}
        </span>
        {breakableExternalLinkText(plainText.slice(leadingLength))}
      </>
    );
  }

  const childNodes = Children.toArray(children);
  const firstChild = childNodes[0];

  if (typeof firstChild === "string" && firstChild.length > 0) {
    const leadingLength = leadingExternalLinkTextLength(firstChild);
    return (
      <>
        <span className="whitespace-nowrap">
          <MarkdownLinkFavicon host={host} />
          {firstChild.slice(0, leadingLength)}
        </span>
        {breakableExternalLinkText(firstChild.slice(leadingLength))}
        {childNodes.slice(1)}
      </>
    );
  }

  return (
    <>
      <span className="[overflow-wrap:anywhere]">
        <MarkdownLinkFavicon host={host} />
        {firstChild}
      </span>
      {childNodes.slice(1)}
    </>
  );
}
