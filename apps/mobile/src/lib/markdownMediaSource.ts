import { classifyMarkdownImageSource } from "@t3tools/client-runtime/markdown-images";
import {
  resolveMediaSource,
  type ResolveMediaSourceInput,
} from "@t3tools/client-runtime/media-source";
import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import { SOURCE_CONTROL_MEDIA_ASSET } from "@t3tools/contracts";

export function resolveMobileMarkdownMediaSource(
  href: string,
  input: ResolveMediaSourceInput & { readonly captured?: boolean | undefined },
) {
  const media = resolveMediaSource(href, input);
  if (media?.access === "direct") {
    // A private repository's media 404s without a credential; the server holds `cwd`'s.
    const fetchUrl = sourceControlClients.mediaUrl(media.uri)?.fetchUrl;
    if (fetchUrl === undefined || !input.workspaceRoot || input.captured) return media;
    return {
      ...media,
      access: "environment" as const,
      resource: { _tag: SOURCE_CONTROL_MEDIA_ASSET, cwd: input.workspaceRoot, url: fetchUrl },
    };
  }
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
