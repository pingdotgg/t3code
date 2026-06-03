/**
 * Custom markdown renderer for changelogithub-parsed commits.
 *
 * Mirrors the output of changelogithub's built-in generator but groups
 * conventional-commit scopes hierarchically by splitting on `/`. For
 * example commits like `fix(aws/lambda): ...`, `fix(aws/s3): ...` and
 * `fix(aws): ...` render as nested categories under a shared `**aws**`
 * top-level scope rather than as three unrelated flat groups.
 *
 * Line-level formatting (authors, PR/issue links, `<samp>` hash tags,
 * `&nbsp;` spacing) is kept byte-compatible with changelogithub so output
 * for single-segment scopes is identical to the upstream renderer.
 */
import type { ChangelogOptions, Commit } from "changelogithub";

export type RenderConfig = Required<
  Pick<
    ChangelogOptions,
    | "titles"
    | "types"
    | "capitalize"
    | "emoji"
    | "baseUrl"
    | "repo"
    | "from"
    | "to"
  >
> & {
  scopeMap?: Record<string, string>;
};

const emojisRE =
  /([\u2700-\u27BF\uE000-\uF8FF\u2011-\u26FF]|\uD83C[\uDC00-\uDFFF]|\uD83D[\uDC00-\uDFFF]|\uD83E[\uDD10-\uDDFF])/g;

export function renderMarkdown(
  commits: Commit[],
  config: RenderConfig,
): string {
  const lines: string[] = [];
  const [breaking, rest] = partition(commits, (c) => c.isBreaking);

  if (config.titles?.breakingChanges) {
    lines.push(
      ...renderSection(breaking, config.titles.breakingChanges, config),
    );
  }

  const byType = groupBy(rest, (c) => c.type);
  for (const type of Object.keys(config.types)) {
    const items = byType[type] || [];
    lines.push(...renderSection(items, config.types[type].title, config));
  }

  if (!lines.length) lines.push("*No significant changes*");

  const url = `https://${config.baseUrl}/${config.repo}/compare/${config.from}...${config.to}`;
  lines.push(
    "",
    `##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](${url})`,
  );

  return lines.join("\n").trim();
}

interface Node {
  commits: Commit[];
  children: Record<string, Node>;
}

function makeNode(): Node {
  return { commits: [], children: {} };
}

function renderSection(
  commits: Commit[],
  sectionName: string,
  config: RenderConfig,
): string[] {
  if (!commits.length) return [];
  const out: string[] = ["", formatTitle(sectionName, config), ""];

  // Build a tree keyed by the `/`-separated scope segments. Commits attach
  // to the deepest node that matches their scope exactly.
  const root = makeNode();
  for (const commit of commits) {
    const scope = (commit.scope ?? "").trim();
    const mapped = config.scopeMap?.[scope] ?? scope;
    const segments = mapped
      ? mapped
          .split("/")
          .map((s) => s.trim())
          .filter(Boolean)
      : [];
    let node = root;
    for (const seg of segments) {
      node.children[seg] ??= makeNode();
      node = node.children[seg];
    }
    node.commits.push(commit);
  }

  out.push(...renderNode(root, 0, config));
  return out;
}

function renderNode(node: Node, depth: number, config: RenderConfig): string[] {
  const lines: string[] = [];
  const pad = "  ".repeat(depth);

  // Reverse to match changelogithub's ordering: commits come out of git log
  // newest-first, and the upstream renderer flips them so the oldest entry
  // in the range appears at the top of each bucket.
  for (const commit of [...node.commits].reverse()) {
    lines.push(`${pad}- ${formatLine(commit, config)}`);
  }

  const childNames = Object.keys(node.children).sort();

  // Match changelogithub's `group: true` default: within a given level, if
  // ANY sibling scope has more than a single inline-able commit (either
  // multiple commits or further sub-scopes), force every sibling to render
  // with a header. This keeps visual alignment consistent and is what the
  // existing CHANGELOG.md entries already use, so it avoids regressing
  // historical release-notes style.
  const forceHeaders = childNames.some((name) => {
    const child = node.children[name];
    return countCommits(child) > 1 || Object.keys(child.children).length > 0;
  });

  for (const name of childNames) {
    const child = node.children[name];
    const label = `**${name}**`;

    const childCommitCount = countCommits(child);
    const hasGrandchildren = Object.keys(child.children).length > 0;

    // Collapse inline only when NO sibling wants a header and this child is
    // a single-commit leaf. Otherwise emit the header + nested bullets.
    if (!forceHeaders && childCommitCount === 1 && !hasGrandchildren) {
      const [commit] = child.commits;
      lines.push(`${pad}- ${label}: ${formatLine(commit, config)}`);
      continue;
    }

    lines.push(`${pad}- ${label}:`);
    lines.push(...renderNode(child, depth + 1, config));
  }

  return lines;
}

function countCommits(node: Node): number {
  let n = node.commits.length;
  for (const child of Object.values(node.children)) n += countCommits(child);
  return n;
}

function formatTitle(name: string, config: RenderConfig): string {
  if (!config.emoji) name = name.replace(emojisRE, "");
  return `### &nbsp;&nbsp;&nbsp;${name.trim()}`;
}

function formatLine(commit: Commit, config: RenderConfig): string {
  const prRefs = formatReferences(commit.references, config, "issues");
  const hashRefs = formatReferences(commit.references, config, "hash");
  const authorNames = [
    ...new Set(
      (commit.resolvedAuthors ?? []).map((a) =>
        a.login ? `@${a.login}` : `**${a.name}**`,
      ),
    ),
  ];
  const authors = joinWithAnd(authorNames).trim();
  const authorStr = authors ? `by ${authors}` : "";
  let refs = [authorStr, prRefs, hashRefs]
    .filter((s) => s && s.trim())
    .join(" ");
  if (refs) refs = `&nbsp;-&nbsp; ${refs}`;
  const description = config.capitalize
    ? capitalize(commit.description)
    : commit.description;
  return [description, refs].filter((s) => s && s.trim()).join(" ");
}

function formatReferences(
  references: Commit["references"],
  config: RenderConfig,
  kind: "issues" | "hash",
): string {
  const baseUrl = config.baseUrl;
  const repo = config.repo;
  const refs = references
    .filter((r) =>
      kind === "issues"
        ? r.type === "issue" || r.type === "pull-request"
        : r.type === "hash",
    )
    .map((ref) => {
      if (!repo) return ref.value;
      if (ref.type === "pull-request" || ref.type === "issue") {
        return `https://${baseUrl}/${repo}/issues/${ref.value.slice(1)}`;
      }
      return `[<samp>(${ref.value.slice(0, 5)})</samp>](https://${baseUrl}/${repo}/commit/${ref.value})`;
    });
  const joined = joinWithAnd(refs).trim();
  if (kind === "issues") return joined ? `in ${joined}` : "";
  return joined;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function joinWithAnd(
  array: string[],
  glue = ", ",
  finalGlue = " and ",
): string {
  if (!array || array.length === 0) return "";
  if (array.length === 1) return array[0];
  if (array.length === 2) return array.join(finalGlue);
  return `${array.slice(0, -1).join(glue)}${finalGlue}${array.slice(-1)}`;
}

function partition<T>(items: T[], pred: (item: T) => boolean): [T[], T[]] {
  const yes: T[] = [];
  const no: T[] = [];
  for (const item of items) (pred(item) ? yes : no).push(item);
  return [yes, no];
}

function groupBy<T>(items: T[], key: (item: T) => string): Record<string, T[]> {
  const out: Record<string, T[]> = {};
  for (const item of items) {
    const k = key(item);
    (out[k] ??= []).push(item);
  }
  return out;
}
