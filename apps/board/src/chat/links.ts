import { parseMarkdownFileLink } from "@t3tools/shared/markdownLinks";

import { isWebLink } from "../browser/tabs";
import type { Artifact } from "../store/artifacts";

export type LinkTarget =
  | { readonly kind: "pull-request"; readonly label: string }
  | { readonly kind: "issue"; readonly label: string }
  | { readonly kind: "web" }
  | { readonly kind: "file"; readonly path: string }
  | { readonly kind: "anchor" }
  | { readonly kind: "other" };

const GITHUB_REFERENCE =
  /^https?:\/\/github\.com\/[^/]+\/([^/]+)\/(pull|issues)\/(\d+)(?:[/?#]|$)/i;
const LINEAR_ISSUE =
  /^https?:\/\/linear\.app\/[^/]+\/issue\/([A-Za-z][A-Za-z0-9]*-\d+)(?:[/?#]|$)/i;

/** What a link in a reply points at, which decides where a click on it goes. */
export function classifyLink(href: string): LinkTarget {
  if (href.startsWith("#")) return { kind: "anchor" };
  if (isWebLink(href)) {
    const github = GITHUB_REFERENCE.exec(href);
    if (github?.[1] && github[3]) {
      return {
        kind: github[2]?.toLowerCase() === "pull" ? "pull-request" : "issue",
        label: `${github[1]}#${github[3]}`,
      };
    }
    const linear = LINEAR_ISSUE.exec(href);
    if (linear?.[1]) return { kind: "issue", label: linear[1] };
    return { kind: "web" };
  }
  const file = parseMarkdownFileLink(href);
  return file === null ? { kind: "other" } : { kind: "file", path: file.path };
}

const slashes = (path: string) => path.replaceAll("\\", "/").replace(/^(?:\.\/)+/, "");

/**
 * The artifact a file path names: the same absolute path, the same path under the store, or the
 * tail of an absolute path. A tail that more than one artifact ends with names none of them.
 */
export function findArtifact(path: string, artifacts: ReadonlyArray<Artifact>): Artifact | null {
  const wanted = slashes(path);
  if (wanted === "") return null;
  const exact = artifacts.find(
    (artifact) => slashes(artifact.absolutePath) === wanted || artifact.path === wanted,
  );
  if (exact) return exact;
  const tails = artifacts.filter((artifact) =>
    slashes(artifact.absolutePath).endsWith(`/${wanted}`),
  );
  return tails.length === 1 ? (tails[0] ?? null) : null;
}
