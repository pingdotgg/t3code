import { useQuery } from "@tanstack/react-query";
import { ExternalLinkIcon, LoaderCircleIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { APP_VERSION, GITHUB_REPO_URL } from "~/branding";
import { changelogQueryOptions } from "~/lib/changelogReactQuery";
import { cn, formatRelativeTime } from "~/lib/utils";
import { openExternalUrl } from "~/nativeApi";
import { GitHubIcon } from "./Icons";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";

interface ChangelogDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  highlightVersion?: string | null | undefined;
}

/**
 * Parse a single changelog line like:
 *   "fix(web): add pointer cursor by @binbandit in https://github.com/.../pull/1220"
 * into structured parts for rich rendering.
 */
interface ChangelogEntry {
  description: string;
  author: string | null;
  prNumber: string | null;
  prUrl: string | null;
}

function parseChangelogLine(line: string): ChangelogEntry {
  const cleaned = line.replace(/^\*\s*/, "").trim();

  const authorMatch = cleaned.match(/ by @([\w-]+)/);
  const prMatch = cleaned.match(/ in (https:\/\/github\.com\/[\w-]+\/[\w-]+\/pull\/(\d+))$/);

  let description = cleaned;
  if (authorMatch) {
    description = description.slice(0, authorMatch.index).trim();
  }
  if (!authorMatch && prMatch) {
    description = description.slice(0, prMatch.index).trim();
  }

  return {
    description,
    author: authorMatch ? authorMatch[1]! : null,
    prNumber: prMatch ? prMatch[2]! : null,
    prUrl: prMatch ? prMatch[1]! : null,
  };
}

interface ParsedSection {
  title: string;
  entries: ChangelogEntry[];
}

function parseReleaseBody(body: string): {
  sections: ParsedSection[];
  fullChangelogUrl: string | null;
} {
  const lines = body.split("\n");
  const sections: ParsedSection[] = [];
  let currentSection: ParsedSection | null = null;
  let fullChangelogUrl: string | null = null;

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed.startsWith("**Full Changelog**:")) {
      const urlMatch = trimmed.match(/https:\/\/[^\s]+/);
      if (urlMatch) fullChangelogUrl = urlMatch[0]!;
      continue;
    }

    if (trimmed.startsWith("## ")) {
      currentSection = { title: trimmed.replace(/^##\s*/, ""), entries: [] };
      sections.push(currentSection);
      continue;
    }

    if (trimmed.startsWith("* ") && currentSection) {
      currentSection.entries.push(parseChangelogLine(trimmed));
    }
  }

  return { sections, fullChangelogUrl };
}

function ChangelogEntryItem({ entry }: { entry: ChangelogEntry }) {
  return (
    <li className="group flex items-start gap-2 py-1">
      <span className="mt-1.5 size-1 shrink-0 rounded-full bg-muted-foreground/30" />
      <div className="min-w-0 text-xs leading-relaxed">
        <span className="text-muted-foreground">{entry.description}</span>
        {entry.author && (
          <button
            type="button"
            className="ml-1 inline-flex items-center rounded-md bg-accent/50 px-1 py-0.5 text-[10px] font-medium text-foreground/70 transition-colors hover:bg-accent hover:text-foreground"
            onClick={() => openExternalUrl(`https://github.com/${entry.author}`)}
          >
            @{entry.author}
          </button>
        )}
        {entry.prNumber && entry.prUrl && (
          <button
            type="button"
            className="ml-1 inline-flex items-center text-[10px] font-medium text-primary/70 transition-colors hover:text-primary hover:underline"
            onClick={() => openExternalUrl(entry.prUrl!)}
          >
            #{entry.prNumber}
          </button>
        )}
      </div>
    </li>
  );
}

function ReleaseCard({
  tagName,
  publishedAt,
  body,
  htmlUrl,
  isCurrent,
  isHighlighted,
  innerRef,
}: {
  tagName: string;
  publishedAt: string | null;
  body: string | null;
  htmlUrl: string;
  isCurrent: boolean;
  isHighlighted: boolean;
  innerRef?: ((el: HTMLDivElement | null) => void) | undefined;
}) {
  const parsed = body ? parseReleaseBody(body) : null;
  const hasParsedContent = parsed && parsed.sections.some((s) => s.entries.length > 0);

  return (
    <div
      ref={innerRef}
      className={cn(
        "rounded-lg border border-border/40 bg-card/30 p-4 transition-colors",
        isHighlighted && "border-primary/40 bg-primary/5",
      )}
    >
      <div className="mb-3 flex items-center gap-2">
        <span className="text-sm font-semibold text-foreground">{tagName}</span>
        {isCurrent && (
          <span className="rounded-full bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-medium text-emerald-500">
            current
          </span>
        )}
        <span className="text-[11px] text-muted-foreground/50">
          {formatRelativeTime(publishedAt)}
        </span>
        <button
          type="button"
          aria-label="View release on GitHub"
          className="ml-auto inline-flex size-5 items-center justify-center rounded text-muted-foreground/40 transition-colors hover:text-foreground"
          onClick={() => openExternalUrl(htmlUrl)}
        >
          <ExternalLinkIcon className="size-3" />
        </button>
      </div>

      {hasParsedContent
        ? parsed.sections.map((section) => (
            <div key={section.title} className="mb-2 last:mb-0">
              <h4 className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-foreground/50">
                {section.title}
              </h4>
              <ul className="space-y-0">
                {section.entries.map((entry) => (
                  <ChangelogEntryItem
                    key={`${entry.description}-${entry.prNumber ?? ""}`}
                    entry={entry}
                  />
                ))}
              </ul>
            </div>
          ))
        : body && (
            <p className="text-xs leading-relaxed text-muted-foreground/60">
              {body.slice(0, 200)}
              {body.length > 200 ? "…" : ""}
            </p>
          )}

      {!body && <p className="text-xs italic text-muted-foreground/40">No release notes.</p>}

      {parsed?.fullChangelogUrl && (
        <button
          type="button"
          className="mt-2 text-[10px] text-muted-foreground/40 transition-colors hover:text-primary"
          onClick={() => openExternalUrl(parsed.fullChangelogUrl!)}
        >
          Full changelog &rarr;
        </button>
      )}
    </div>
  );
}

function isVersionMatch(tagName: string, target: string): boolean {
  const version = tagName.replace(/^v/, "");
  return tagName === target || version === target.replace(/^v/, "");
}

export function ChangelogDialog({ open, onOpenChange, highlightVersion }: ChangelogDialogProps) {
  const {
    data: releases,
    isLoading,
    error,
  } = useQuery({ ...changelogQueryOptions(), enabled: open });
  const [activeTag, setActiveTag] = useState<string | null>(null);
  const cardRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  const scrollToVersion = useCallback((tag: string) => {
    setActiveTag(tag);
    const el = cardRefs.current.get(tag);
    el?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);

  // Scroll to highlighted version on open
  useEffect(() => {
    if (!open || !releases?.length || !highlightVersion) return;
    const match = releases.find((r) => isVersionMatch(r.tag_name, highlightVersion));
    if (match) {
      // Defer to next frame so dialog has rendered
      requestAnimationFrame(() => scrollToVersion(match.tag_name));
    }
  }, [open, releases, highlightVersion, scrollToVersion]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Changelog</DialogTitle>
          <DialogDescription>Release history for T3 Code</DialogDescription>
        </DialogHeader>

        {isLoading && (
          <div className="flex justify-center py-12">
            <LoaderCircleIcon className="size-5 animate-spin text-muted-foreground" />
          </div>
        )}

        {error && (
          <div className="py-12 text-center text-sm text-muted-foreground">
            Failed to load releases. Check your internet connection.
          </div>
        )}

        {releases && releases.length > 0 && (
          <div className="flex max-h-[60vh] min-h-0">
            {/* Version sidebar */}
            <nav className="flex w-28 shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-border/30 py-2 pr-2 pl-4">
              {releases.map((release) => {
                const version = release.tag_name.replace(/^v/, "");
                const isCurrent = version === APP_VERSION || release.tag_name === APP_VERSION;
                const isActive = activeTag === release.tag_name;

                return (
                  <button
                    key={release.tag_name}
                    type="button"
                    className={cn(
                      "rounded-md px-2 py-1 text-left text-[11px] transition-colors",
                      isActive
                        ? "bg-accent text-foreground font-medium"
                        : "text-muted-foreground/60 hover:bg-accent/50 hover:text-muted-foreground",
                    )}
                    onClick={() => scrollToVersion(release.tag_name)}
                  >
                    <span className="flex items-center justify-between gap-1">
                      <span>{release.tag_name}</span>
                      {isCurrent && (
                        <span className="size-1.5 shrink-0 rounded-full bg-emerald-500" />
                      )}
                    </span>
                  </button>
                );
              })}
            </nav>

            {/* Release cards */}
            <DialogPanel className="flex-1 space-y-3 overflow-y-auto">
              {releases.map((release) => {
                const version = release.tag_name.replace(/^v/, "");
                const isCurrent = version === APP_VERSION || release.tag_name === APP_VERSION;
                const isHighlighted =
                  !!highlightVersion && isVersionMatch(release.tag_name, highlightVersion);

                return (
                  <ReleaseCard
                    key={release.tag_name}
                    tagName={release.tag_name}
                    publishedAt={release.published_at}
                    body={release.body}
                    htmlUrl={release.html_url}
                    isCurrent={isCurrent}
                    isHighlighted={isHighlighted}
                    innerRef={(el) => {
                      if (el) cardRefs.current.set(release.tag_name, el);
                      else cardRefs.current.delete(release.tag_name);
                    }}
                  />
                );
              })}
            </DialogPanel>
          </div>
        )}

        <div className="flex items-center justify-end border-t border-border/30 px-6 py-2.5">
          <button
            type="button"
            className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs text-muted-foreground/60 transition-colors hover:bg-accent hover:text-foreground"
            onClick={() => openExternalUrl(GITHUB_REPO_URL)}
          >
            <GitHubIcon className="size-3.5" />
            View on GitHub
          </button>
        </div>
      </DialogPopup>
    </Dialog>
  );
}
