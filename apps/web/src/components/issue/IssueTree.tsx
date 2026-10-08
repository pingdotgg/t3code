import {
  formatIssueReference,
  type IssueLinkedPullRequest,
  type IssueReferenceStyle,
  type IssueRelative,
  type IssueRelativeNode,
  normalizeWorkItemLinkKey,
} from "@t3tools/contracts";

import { cn } from "~/lib/utils";
import { resolvePullRequestState } from "../pullRequest/pullRequestPresentation";
import { IssueStateGlyph } from "./issuePresentation";

/** The fields a tree needs from an issue detail: itself, what is above it and what is below. */
export interface IssueTreeRoot extends IssueRelative {
  readonly ancestors?: ReadonlyArray<IssueRelative> | undefined;
  readonly subIssues?: ReadonlyArray<IssueRelativeNode> | undefined;
}

export interface IssueTreeRowData {
  readonly issue: IssueRelative;
  readonly depth: number;
  readonly current: boolean;
}

export function countIssueNodes(nodes: ReadonlyArray<IssueRelativeNode>): number {
  return nodes.reduce((total, node) => total + 1 + countIssueNodes(node.subIssues), 0);
}

/** Ancestors from the root down, this issue, then its sub-issues depth-first beneath it. */
export function flattenIssueTree(detail: IssueTreeRoot): Array<IssueTreeRowData> {
  const ancestors = detail.ancestors ?? [];
  const rows: Array<IssueTreeRowData> = ancestors.map((issue, depth) => ({
    issue,
    depth,
    current: false,
  }));
  rows.push({ issue: detail, depth: ancestors.length, current: true });
  const visit = (nodes: ReadonlyArray<IssueRelativeNode>, depth: number) => {
    for (const node of nodes) {
      rows.push({ issue: node, depth, current: false });
      visit(node.subIssues, depth + 1);
    }
  };
  visit(detail.subIssues ?? [], ancestors.length + 1);
  return rows;
}

/** A linked issue's tree as read from its tracker, keyed for merging with the others. */
export interface LinkedIssueTreeSource {
  readonly provider: string;
  readonly linkKey: string;
  readonly detail: IssueTreeRoot;
}

export interface MergedIssueTreeRow {
  readonly issue: IssueRelative;
  readonly depth: number;
  /** Set on the issues the thread is linked to. */
  readonly linkKey: string | null;
}

interface MergeNode {
  issue: IssueRelative;
  linkKey: string | null;
  readonly children: Map<string, MergeNode>;
}

function issueIdentity(issue: IssueRelative, provider: string): string {
  return normalizeWorkItemLinkKey({ provider, url: issue.url }).url.toLowerCase();
}

export function issueTreeLabel(
  issue: IssueRelative,
  repository: string,
  referenceStyle: IssueReferenceStyle,
): string {
  const own = issue.repository ?? repository;
  if (referenceStyle === "key-number") {
    return formatIssueReference({ repository: own, number: issue.number, referenceStyle });
  }
  return own.toLowerCase() === repository.toLowerCase()
    ? `#${issue.number}`
    : formatIssueReference({ repository: own, number: issue.number });
}

/**
 * One tree per top ancestor: linked issues that share one are placed in the same tree, each
 * where it sits, and an issue reached by two linked trees is drawn once.
 */
export function mergeIssueTrees(
  sources: ReadonlyArray<LinkedIssueTreeSource>,
): Array<{ readonly key: string; readonly rows: ReadonlyArray<MergedIssueTreeRow> }> {
  const roots = new Map<string, MergeNode>();
  const place = (
    container: Map<string, MergeNode>,
    issue: IssueRelative,
    provider: string,
  ): MergeNode => {
    const key = issueIdentity(issue, provider);
    const existing = container.get(key);
    if (existing === undefined) {
      const created: MergeNode = { issue, linkKey: null, children: new Map() };
      container.set(key, created);
      return created;
    }
    // Keep the copy that carries pull requests, which only some reads ask for.
    if (existing.issue.linkedPullRequests === undefined && issue.linkedPullRequests !== undefined) {
      existing.issue = issue;
    }
    return existing;
  };
  const graft = (
    node: MergeNode,
    subIssues: ReadonlyArray<IssueRelativeNode>,
    provider: string,
  ) => {
    for (const sub of subIssues) {
      graft(place(node.children, sub, provider), sub.subIssues, provider);
    }
  };
  const parents = new Map<string, IssueRelative>();
  for (const { provider, detail } of sources) {
    const path: Array<IssueRelative> = [];
    for (const row of flattenIssueTree(detail)) {
      path[row.depth] = row.issue;
      if (row.depth > 0) parents.set(issueIdentity(row.issue, provider), path[row.depth - 1]!);
    }
  }
  for (const { provider, linkKey, detail } of sources) {
    const chain = [...(detail.ancestors ?? []), detail];
    const seen = new Set(chain.map((issue) => issueIdentity(issue, provider)));
    let parent = parents.get(issueIdentity(chain[0]!, provider));
    while (parent !== undefined && !seen.has(issueIdentity(parent, provider))) {
      seen.add(issueIdentity(parent, provider));
      chain.unshift(parent);
      parent = parents.get(issueIdentity(parent, provider));
    }
    const top = chain[0]!;
    const rootKey = issueIdentity(top, provider);
    let node = roots.get(rootKey);
    if (node === undefined) {
      node = { issue: top, linkKey: null, children: new Map() };
      roots.set(rootKey, node);
    } else if (
      node.issue.linkedPullRequests === undefined &&
      top.linkedPullRequests !== undefined
    ) {
      node.issue = top;
    }
    for (const issue of chain.slice(1)) node = place(node.children, issue, provider);
    node.issue = detail;
    node.linkKey = linkKey;
    graft(node, detail.subIssues ?? [], provider);
  }
  return [...roots].map(([key, root]) => {
    const rows: Array<MergedIssueTreeRow> = [];
    const visit = (node: MergeNode, depth: number) => {
      rows.push({ issue: node.issue, depth, linkKey: node.linkKey });
      for (const child of node.children.values()) visit(child, depth + 1);
    };
    visit(root, 0);
    return { key, rows };
  });
}

export function IssueTreeRow({
  row,
  repository,
  referenceStyle,
  onOpen,
  onOpenCurrent,
}: {
  row: IssueTreeRowData;
  repository: string;
  referenceStyle: IssueReferenceStyle;
  onOpen: (issue: IssueRelative) => void;
  /** Where the issue itself is a link too, as in a panel listing several trees. */
  onOpenCurrent?: () => void;
}) {
  const content = (
    <>
      <IssueStateGlyph state={row.issue.state} stateReason={null} className="size-3.5" />
      <span className={cn("min-w-0 flex-1 truncate", row.current && "font-medium")}>
        {row.issue.title}
      </span>
      <span className="shrink-0 text-muted-foreground tabular-nums">
        {issueTreeLabel(row.issue, repository, referenceStyle)}
      </span>
    </>
  );
  const className =
    "flex w-full min-w-0 items-center gap-2 rounded-md py-1.5 pr-2 text-left text-xs";
  // One indent step per level of the tree.
  const style = { paddingLeft: `${0.5 + row.depth * 1}rem` };
  return row.current && onOpenCurrent === undefined ? (
    <div
      role="treeitem"
      aria-current="true"
      aria-level={row.depth + 1}
      style={style}
      className={cn(className, "bg-accent/40")}
    >
      {content}
    </div>
  ) : (
    <button
      type="button"
      role="treeitem"
      aria-level={row.depth + 1}
      style={style}
      {...(row.current ? { "aria-current": true } : {})}
      onClick={() => (row.current ? onOpenCurrent?.() : onOpen(row.issue))}
      className={cn(className, "hover:bg-accent/60", row.current && "bg-accent/40")}
    >
      {content}
    </button>
  );
}

/** The pull requests the tracker reports for an issue, nested one step under its row. */
export function IssueTreePullRequestRows({
  links,
  depth,
  onOpen,
}: {
  links: ReadonlyArray<IssueLinkedPullRequest> | undefined;
  depth: number;
  onOpen: (link: IssueLinkedPullRequest) => void;
}) {
  return (links ?? []).map((link) => {
    const presentation = resolvePullRequestState({ state: link.state, isDraft: link.isDraft });
    return (
      <button
        key={link.url}
        type="button"
        onClick={() => onOpen(link)}
        style={{ paddingLeft: `${0.5 + (depth + 1) * 1}rem` }}
        className="flex w-full min-w-0 items-center gap-2 rounded-md py-1 pr-2 text-left text-xs text-muted-foreground hover:bg-accent/60"
      >
        <presentation.Icon
          role="img"
          aria-label={presentation.label}
          className={cn("size-3.5 shrink-0", presentation.toneClassName)}
        />
        <span className="min-w-0 flex-1 truncate">{link.title}</span>
        <span className="shrink-0 tabular-nums">#{link.number}</span>
      </button>
    );
  });
}
