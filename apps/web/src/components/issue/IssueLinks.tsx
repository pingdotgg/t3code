import type { IssueDetail, IssueRef } from "@t3tools/contracts";
import { ExternalLinkIcon } from "lucide-react";
import { InlineButton } from "../ui/button";
import { Badge } from "../ui/badge";

export function IssueLinks({
  detail,
  reference,
  onSelectIssue,
}: {
  detail: IssueDetail;
  reference: IssueRef;
  onSelectIssue?: ((reference: IssueRef) => void) | undefined;
}) {
  const relatedIssues = [
    ...new Map(
      (detail.relatedIssues ?? []).map((issue) => [`${issue.relation}:${issue.key}`, issue]),
    ).values(),
  ];
  const webLinks = [...new Map((detail.webLinks ?? []).map((link) => [link.url, link])).values()];
  return (
    <>
      {detail.relatedIssues !== undefined ? (
        <section className="flex flex-col gap-2" aria-label="Linked issues">
          <h3 className="text-xs text-muted-foreground">Linked issues</h3>
          {detail.relatedIssues.length === 0 ? (
            <p className="text-xs text-muted-foreground">No linked issues.</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {relatedIssues.map((issue) => (
                <li
                  key={`${issue.relation}:${issue.key}`}
                  className="flex min-w-0 flex-wrap items-center gap-2 text-xs"
                >
                  <span className="text-muted-foreground">{issue.relation}</span>
                  <InlineButton
                    render={
                      <a
                        href={issue.url}
                        onClick={(event) => {
                          if (
                            !onSelectIssue ||
                            event.metaKey ||
                            event.ctrlKey ||
                            event.shiftKey ||
                            event.altKey ||
                            event.button !== 0
                          )
                            return;
                          event.preventDefault();
                          onSelectIssue({
                            ...reference,
                            host: detail.host,
                            key: issue.key,
                            scope: issue.scope,
                          });
                        }}
                      />
                    }
                  >
                    {issue.key} · {issue.title}
                  </InlineButton>
                  {issue.state ? <Badge variant="outline">{issue.state.name}</Badge> : null}
                </li>
              ))}
            </ul>
          )}
          {detail.relatedIssuesTruncated ? (
            <InlineButton
              render={<a href={detail.url} target="_blank" rel="noopener noreferrer" />}
            >
              View all linked issues on {detail.tracker}
            </InlineButton>
          ) : null}
        </section>
      ) : null}
      {detail.webLinks !== undefined ? (
        <section className="flex flex-col gap-2" aria-label="Web links">
          <h3 className="text-xs text-muted-foreground">Web links</h3>
          {detail.webLinks.length === 0 ? (
            <p className="text-xs text-muted-foreground">No web links.</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {webLinks.map((link) => (
                <li key={link.url} className="min-w-0 text-xs">
                  <InlineButton
                    render={<a href={link.url} target="_blank" rel="noopener noreferrer" />}
                  >
                    {link.title}
                    <ExternalLinkIcon aria-hidden className="size-3" />
                  </InlineButton>
                </li>
              ))}
            </ul>
          )}
          {detail.webLinksTruncated ? (
            <InlineButton
              render={<a href={detail.url} target="_blank" rel="noopener noreferrer" />}
            >
              View all web links on {detail.tracker}
            </InlineButton>
          ) : null}
        </section>
      ) : null}
    </>
  );
}
