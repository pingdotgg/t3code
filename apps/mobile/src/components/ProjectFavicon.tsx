import { deriveProjectIdentity } from "@t3tools/client-runtime/project-identity";
import { SymbolView } from "./AppSymbol";
import { AppText } from "./AppText";
import { Image } from "expo-image";
import { memo, useLayoutEffect, useMemo, useState } from "react";
import { View } from "react-native";
import type { EnvironmentId, ProjectIconOverride } from "@t3tools/contracts";
import {
  getProjectFaviconCacheKey,
  getProjectFaviconResourceKey,
  isProjectFaviconFallbackUrl,
} from "@t3tools/shared/projectFavicon";
import { useAtomValue } from "@effect/atom-react";
import { Atom } from "effect/reactivity";
import { projectFaviconUrlAtom } from "../state/assets";
import {
  countGlyphs,
  projectIconColorClassNames,
  resolveProjectIconGlyph,
  type ProjectIconGlyph,
} from "../lib/projectIcon";

import {
  beginProjectFaviconRequest,
  createProjectFaviconRequest,
  hasLoadedProjectFavicon,
  markProjectFaviconFailed,
  markProjectFaviconLoaded,
} from "../lib/projectFaviconRequests";

const EMPTY_FAVICON_URL = Atom.make<string | null>(null);

/* ─── Component ──────────────────────────────────────────────────────── */
export const ProjectFavicon = memo(function ProjectFavicon(props: {
  readonly environmentId: EnvironmentId;
  readonly size?: number;
  readonly projectTitle: string;
  readonly workspaceRoot?: string | null;
  readonly faviconPath?: string | null;
  readonly projectIcon?: ProjectIconOverride | null;
}) {
  const size = props.size ?? 42;
  const glyph = resolveProjectIconGlyph(props.projectIcon, props.projectTitle);
  const faviconUrl = useAtomValue(
    props.workspaceRoot == null || glyph !== null
      ? EMPTY_FAVICON_URL
      : projectFaviconUrlAtom({
          environmentId: props.environmentId,
          cwd: props.workspaceRoot,
          faviconPath: props.faviconPath,
        }),
  );
  const renderableFaviconUrl = useMemo(
    () => (isProjectFaviconFallbackUrl(faviconUrl) ? null : faviconUrl),
    [faviconUrl],
  );
  // Inline images are self-contained; remote URLs key on their revision so signed-token
  // rotation reuses the disk cache while a changed icon starts from the loading state.
  const cacheKey = useMemo(
    () =>
      renderableFaviconUrl && props.workspaceRoot
        ? renderableFaviconUrl.startsWith("data:")
          ? getProjectFaviconResourceKey(
              props.environmentId,
              props.workspaceRoot,
              props.faviconPath,
            )
          : getProjectFaviconCacheKey(
              props.environmentId,
              props.workspaceRoot,
              renderableFaviconUrl,
            )
        : null,
    [renderableFaviconUrl, props.environmentId, props.workspaceRoot, props.faviconPath],
  );

  if (glyph !== null) {
    return <ProjectIconGlyphView glyph={glyph} size={size} />;
  }

  return (
    <ProjectFaviconImage
      key={cacheKey}
      cacheKey={cacheKey}
      faviconUrl={renderableFaviconUrl}
      projectTitle={props.projectTitle}
      size={size}
    />
  );
});

function ProjectIconGlyphView(props: { readonly glyph: ProjectIconGlyph; readonly size: number }) {
  const { glyph, size } = props;
  if (glyph.kind === "emoji") {
    return (
      <View style={{ width: size, height: size, alignItems: "center", justifyContent: "center" }}>
        <AppText
          allowFontScaling={false}
          style={{
            fontSize: size * 0.8,
            lineHeight: size,
            textAlign: "center",
            includeFontPadding: false,
          }}
        >
          {glyph.emoji}
        </AppText>
      </View>
    );
  }

  const colors = projectIconColorClassNames(glyph.color);
  return (
    <View
      className={colors.background}
      style={{
        width: size,
        height: size,
        borderRadius: size * 0.25,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <AppText
        allowFontScaling={false}
        numberOfLines={1}
        className={`font-mono ${colors.text}`}
        style={{
          fontWeight: "700",
          fontSize: size * (countGlyphs(glyph.text) === 1 ? 0.6 : 0.515625),
          lineHeight: size,
          textAlign: "center",
          includeFontPadding: false,
        }}
      >
        {glyph.text}
      </AppText>
    </View>
  );
}

/** Stands in for a missing or still-loading favicon, like web's automatic project icon. */
function ProjectFaviconFallback(props: { readonly projectTitle: string; readonly size: number }) {
  if (props.projectTitle.trim().length === 0) {
    return (
      <SymbolView
        name={{ ios: "folder.fill", android: "folder" }}
        size={props.size}
        tintColorClassName={"accent-icon-subtle"}
        type="monochrome"
      />
    );
  }
  const identity = deriveProjectIdentity(props.projectTitle);
  return (
    <ProjectIconGlyphView
      glyph={{ kind: "monogram", text: identity.monogram, color: identity.color }}
      size={props.size}
    />
  );
}

function ProjectFaviconImage(props: {
  readonly cacheKey: string | null;
  readonly faviconUrl: string | null;
  readonly projectTitle: string;
  readonly size: number;
}) {
  const faviconRequest = useMemo(
    () => createProjectFaviconRequest(props.cacheKey, props.faviconUrl),
    [props.cacheKey, props.faviconUrl],
  );
  const [activeFaviconRequest, setActiveFaviconRequest] = useState<typeof faviconRequest>(null);
  useLayoutEffect(() => {
    if (faviconRequest === null) return;

    const endRequest = beginProjectFaviconRequest(faviconRequest);
    setActiveFaviconRequest(faviconRequest);
    return endRequest;
  }, [faviconRequest]);

  const [status, setStatus] = useState<"loading" | "loaded" | "error">(() =>
    props.faviconUrl?.startsWith("data:") || hasLoadedProjectFavicon(props.cacheKey)
      ? "loaded"
      : "loading",
  );

  const requestIsActive = faviconRequest !== null && activeFaviconRequest === faviconRequest;
  const showImage = requestIsActive && status === "loaded";

  return (
    <View
      style={{
        width: props.size,
        height: props.size,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {!showImage ? (
        <ProjectFaviconFallback projectTitle={props.projectTitle} size={props.size} />
      ) : null}

      {/* Favicon image (hidden until loaded) */}
      {requestIsActive ? (
        <Image
          key={faviconRequest.faviconUrl}
          source={
            faviconRequest.faviconUrl.startsWith("data:")
              ? { uri: faviconRequest.faviconUrl }
              : { uri: faviconRequest.faviconUrl, cacheKey: faviconRequest.cacheKey }
          }
          cachePolicy={faviconRequest.faviconUrl.startsWith("data:") ? "memory" : "memory-disk"}
          recyclingKey={faviconRequest.cacheKey}
          accessibilityLabel={`${props.projectTitle} favicon`}
          style={{
            width: props.size,
            height: props.size,
            borderRadius: props.size * 0.16,
            ...(showImage ? {} : { position: "absolute" as const, opacity: 0 }),
          }}
          contentFit="contain"
          onLoad={() => {
            if (!markProjectFaviconLoaded(faviconRequest)) return;
            setStatus("loaded");
          }}
          onError={() => {
            if (!markProjectFaviconFailed(faviconRequest)) return;
            setStatus("error");
          }}
        />
      ) : null}
    </View>
  );
}
