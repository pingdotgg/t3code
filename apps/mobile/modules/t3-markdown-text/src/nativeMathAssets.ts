import { Asset } from "expo-asset";
import { File } from "expo-file-system";
import { markdownFileIconSource } from "./markdownFileIcons";
import { markdownLinkIconSource } from "./markdownLinkIcons";
import { resolveMarkdownLinkIcon } from "./markdownLinks";
import type { NativeMarkdownTextRun } from "./nativeMarkdownText";

// These keys come only from the finite set of bundled Markdown icon assets.
const icons = new Map<string, Promise<string>>();

export function nativeMathIconKey(run: NativeMarkdownTextRun): string | undefined {
  if (run.fileIcon) return `file:${run.fileIcon}`;
  const linkIcon = run.externalHost && resolveMarkdownLinkIcon(run.externalHost);
  return linkIcon ? `link:${linkIcon}` : undefined;
}

/** Embed bundled icons so the WebView never needs file access or remote image permissions. */
export async function loadNativeMathIcons(runs: ReadonlyArray<NativeMarkdownTextRun>) {
  const entries = new Map<string, Promise<string>>();
  for (const run of runs) {
    const key = nativeMathIconKey(run);
    if (!key || entries.has(key)) continue;
    let icon = icons.get(key);
    if (!icon) {
      const linkIcon = run.externalHost && resolveMarkdownLinkIcon(run.externalHost);
      const source = run.fileIcon
        ? markdownFileIconSource(run.fileIcon)
        : linkIcon
          ? markdownLinkIconSource(linkIcon)
          : undefined;
      if (typeof source !== "number") continue;
      icon = Asset.fromModule(source)
        .downloadAsync()
        .then(async (asset) => {
          if (!asset.localUri) return "";
          return `data:image/png;base64,${await new File(asset.localUri).base64()}`;
        })
        .catch(() => {
          icons.delete(key);
          return "";
        });
      icons.set(key, icon);
    }
    entries.set(key, icon);
  }
  return Object.fromEntries(
    await Promise.all([...entries].map(async ([key, icon]) => [key, await icon])),
  );
}
