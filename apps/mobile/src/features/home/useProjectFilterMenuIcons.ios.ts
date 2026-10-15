import { useAtomValue } from "@effect/atom-react";
import { deriveProjectIdentity } from "@t3tools/client-runtime/project-identity";
import { isProjectFaviconFallbackUrl } from "@t3tools/shared/projectFavicon";
import { requireOptionalNativeModule } from "expo";
import { Atom } from "effect/reactivity";
import { useEffect, useMemo, useSyncExternalStore } from "react";
import {
  countGlyphs,
  projectIconColorClassNames,
  resolveProjectIconGlyph,
  type ProjectIconGlyph,
} from "../../lib/projectIcon";
import { projectFaviconUrlAtom } from "../../state/assets";
import type { HomeListFilterMenuProject } from "./home-list-filter-menu";

// The menu shows inline images at this size, like its SF Symbols.
const MENU_ICON_SIZE = 20;
const FOLDER_SYMBOL = "folder.fill";
// The same `-500` text on a 15% background that ProjectFavicon draws.
const TILE_BACKGROUND_ALPHA = 0.15;

// Ships in the same binary as the menu's `data:` image support, so older
// binaries without it keep plain text rows.
const NativeControls = requireOptionalNativeModule<{
  readonly renderProjectIconImage?: (
    text: string,
    fontSize: number,
    size: number,
    tint: string | null,
    backgroundAlpha: number,
  ) => string | null;
}>("T3NativeControls");
const renderProjectIconImage = NativeControls?.renderProjectIconImage;

// UIKit builds the menu synchronously, so the favicon has to be handed over as
// bytes (a data URI) instead of a URL the menu would fetch later.
// Loaded favicons live in a module-level store shared by every filter menu.
let faviconDataUris: ReadonlyMap<string, string | null> = new Map();
const pendingFavicons = new Set<string>();
const listeners = new Set<() => void>();
const tileDataUris = new Map<string, string | null>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot() {
  return faviconDataUris;
}

// UIKit can't decode SVG, so those projects get their tile instead.
function isSvg(mimeType: string) {
  return mimeType.startsWith("image/svg");
}

function loadFaviconDataUri(url: string) {
  if (pendingFavicons.has(url)) return;
  pendingFavicons.add(url);
  void fetch(url)
    .then((response) => (response.ok ? response.blob() : null))
    .then(
      (blob) =>
        new Promise<string | null>((resolve) => {
          if (!blob || isSvg(blob.type)) return resolve(null);
          const reader = new FileReader();
          reader.addEventListener("error", () => resolve(null));
          reader.addEventListener("load", () =>
            resolve(typeof reader.result === "string" ? reader.result : null),
          );
          reader.readAsDataURL(blob);
        }),
    )
    .catch(() => null)
    .then((dataUri) => {
      pendingFavicons.delete(url);
      faviconDataUris = new Map(faviconDataUris).set(url, dataUri);
      for (const listener of listeners) listener();
    });
}

/** A favicon the menu can decode, once loaded. */
function menuFavicon(
  url: string | null | undefined,
  dataUris: ReadonlyMap<string, string | null>,
): string | null {
  if (!url) return null;
  // The favicon cache may already hold the icon inline.
  if (url.startsWith("data:")) return isSvg(url.slice("data:".length)) ? null : url;
  return dataUris.get(url) ?? null;
}

/** Renders the glyph ProjectFavicon would draw, cached by text and tint. */
function renderTileDataUri(glyph: ProjectIconGlyph, tint: string | null): string | null {
  if (!renderProjectIconImage) return null;
  const text = glyph.kind === "emoji" ? glyph.emoji : glyph.text;
  const key = `${glyph.kind}\u0000${text}\u0000${tint ?? ""}`;
  const cached = tileDataUris.get(key);
  if (cached !== undefined) return cached;
  const fontScale = glyph.kind === "emoji" ? 0.8 : countGlyphs(text) === 1 ? 0.6 : 0.515625;
  const dataUri = renderProjectIconImage(
    text,
    MENU_ICON_SIZE * fontScale,
    MENU_ICON_SIZE,
    tint,
    glyph.kind === "emoji" ? 0 : TILE_BACKGROUND_ALPHA,
  );
  tileDataUris.set(key, dataUri);
  return dataUri;
}

/**
 * Adds the menu `image` for each project: its favicon, else its assigned icon or
 * generated tile, as a data URI the native menu decodes synchronously.
 */
export function useProjectFilterMenuIcons<T extends HomeListFilterMenuProject>(
  projects: ReadonlyArray<T>,
): ReadonlyArray<T & { readonly image?: string }> {
  const faviconUrls = useAtomValue(
    useMemo(
      () =>
        Atom.make((get) =>
          projects.map((project) => {
            const representative = project.representative;
            if (
              !representative ||
              resolveProjectIconGlyph(representative.projectIcon, representative.title) !== null
            ) {
              return null;
            }
            const url = get(
              projectFaviconUrlAtom({
                environmentId: representative.environmentId,
                cwd: representative.workspaceRoot,
                faviconPath: representative.faviconPath,
              }),
            );
            return isProjectFaviconFallbackUrl(url) ? null : url;
          }),
        ),
      [projects],
    ),
  );

  const dataUris = useSyncExternalStore(subscribe, getSnapshot);
  useEffect(() => {
    if (!renderProjectIconImage) return;
    for (const url of faviconUrls) {
      if (url && !url.startsWith("data:") && !getSnapshot().has(url)) loadFaviconDataUri(url);
    }
  }, [faviconUrls]);

  return useMemo(
    () =>
      projects.map((project, index) => {
        if (!renderProjectIconImage) return project;
        const faviconUri = menuFavicon(faviconUrls[index], dataUris);
        if (faviconUri) return { ...project, image: faviconUri };

        // Like ProjectFavicon: an assigned icon, otherwise the generated tile.
        const title = project.representative?.title ?? "";
        const identity = title.trim().length > 0 ? deriveProjectIdentity(title) : null;
        const glyph =
          resolveProjectIconGlyph(project.representative?.projectIcon, title) ??
          (identity
            ? { kind: "monogram" as const, text: identity.monogram, color: identity.color }
            : null);
        if (!glyph) return { ...project, image: FOLDER_SYMBOL };
        const tileUri = renderTileDataUri(
          glyph,
          glyph.kind === "monogram" ? projectIconColorClassNames(glyph.color).tint : null,
        );
        return tileUri ? { ...project, image: tileUri } : project;
      }),
    [dataUris, faviconUrls, projects],
  );
}
