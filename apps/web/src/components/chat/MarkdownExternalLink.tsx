import { faviconUrlForOrigin } from "@t3tools/shared/favicon";
import { GlobeIcon } from "lucide-react";
import { Children, memo, useState, type ReactNode } from "react";

import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";

import { cn } from "../../lib/utils";
import { sourceControlIcon } from "../../sourceControlPresentation";

// Inline-level and selectable: triple-click selection stops at block-level and select-none boxes.
const MARKDOWN_LINK_FAVICON_CLASS_NAME = "inline-block size-[14px] [vertical-align:-0.125em]";

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
    <span className="ms-[0.25em] me-[0.2em]" aria-hidden>
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
  // A whole code point, so a surrogate pair is not split across elements.
  return Array.from(text.slice(0, 2))[0]?.length ?? 0;
}

const SVG_NS = "http://www.w3.org/2000/svg";
// lucide-react's GlobeIcon, built without React for links streamed outside a React root.
const GLOBE_ICON_NODES: ReadonlyArray<readonly [string, Record<string, string>]> = [
  ["circle", { cx: "12", cy: "12", r: "10" }],
  ["path", { d: "M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20" }],
  ["path", { d: "M2 12h20" }],
];

function createGlobeIcon(className: string): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  for (const [name, value] of Object.entries({
    xmlns: SVG_NS,
    width: "24",
    height: "24",
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    "stroke-width": "2",
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    class: className,
    "aria-hidden": "true",
  }))
    svg.setAttribute(name, value);
  for (const [tag, attributes] of GLOBE_ICON_NODES) {
    const child = document.createElementNS(SVG_NS, tag);
    for (const [name, value] of Object.entries(attributes)) child.setAttribute(name, value);
    svg.append(child);
  }
  return svg;
}

export function createLiveExternalLinkContent(host: string, text: string): DocumentFragment | null {
  if (sourceControlClients.findByPublicDomain(host)) return null;
  const result = document.createDocumentFragment();
  const leading = document.createElement("span");
  leading.className = "whitespace-nowrap";
  const icon = document.createElement("span");
  icon.className = "ms-[0.25em] me-[0.2em]";
  icon.setAttribute("aria-hidden", "true");
  const globe = () => createGlobeIcon(`lucide lucide-globe ${MARKDOWN_LINK_FAVICON_CLASS_NAME}`);
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
