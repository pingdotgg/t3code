import type { EnvironmentId } from "@t3tools/contracts";

import { serverEnvironment } from "~/state/server";
import { useEnvironmentQuery } from "~/state/query";

type HastNode = {
  type?: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
};

const hastText = (node: HastNode): string =>
  node.type === "text" ? (node.value ?? "") : (node.children ?? []).map(hastText).join("");

/** The URL of a paragraph that is only a bare web link, such as an autolinked URL on its own line. */
export function standaloneLinkHref(paragraph: HastNode | undefined): string | null {
  const children = (paragraph?.children ?? []).filter(
    (child) => !(child.type === "text" && (child.value ?? "").trim() === ""),
  );
  const link = children.length === 1 ? children[0] : undefined;
  if (link?.tagName !== "a") return null;
  const href = link.properties?.href;
  if (typeof href !== "string" || !/^https?:\/\//i.test(href)) return null;
  return hastText(link).trim() === href ? href : null;
}

export function MarkdownLinkPreviewCard(props: {
  readonly environmentId: EnvironmentId;
  readonly url: string;
}) {
  const { data } = useEnvironmentQuery(
    serverEnvironment.linkPreview({
      environmentId: props.environmentId,
      input: { url: props.url },
    }),
  );
  if (!data) return null;
  return (
    <div className="my-1 max-w-md rounded-md border border-border/70 px-3 py-2 text-xs">
      {data.title ? <div className="truncate font-medium text-foreground">{data.title}</div> : null}
      {data.description ? (
        <div className="line-clamp-2 text-muted-foreground">{data.description}</div>
      ) : null}
    </div>
  );
}
