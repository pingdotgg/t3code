import { classifyMarkdownImageSource } from "@t3tools/client-runtime/markdown-images";
import {
  resolveMediaSource,
  type ResolveMediaSourceInput,
} from "@t3tools/client-runtime/media-source";

/** A project draft names its workspace explicitly because it has no thread. */
export function resolveMobileMarkdownMediaSource(href: string, input: ResolveMediaSourceInput) {
  const media = resolveMediaSource(href, input);
  if (media?.access !== "unavailable" || !input.workspaceRoot) return media;
  const source = classifyMarkdownImageSource(href, input.workspaceRoot);
  if (source._tag !== "WorkspaceFile") return media;
  return {
    ...media,
    access: "environment" as const,
    resource: {
      _tag: "draft-workspace-file" as const,
      cwd: input.workspaceRoot,
      path: source.path,
    },
  };
}
