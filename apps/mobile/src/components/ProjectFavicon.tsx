import { SymbolView } from "./AppSymbol";
import { Image } from "expo-image";
import { useState } from "react";
import { View } from "react-native";
import type { EnvironmentId } from "@t3tools/contracts";
import { isProjectFaviconFallbackUrl } from "@t3tools/shared/projectFavicon";
import { useThemeColor } from "../lib/useThemeColor";
import { useAssetUrl } from "../state/assets";

/* ─── Favicon cache (matches web pattern) ────────────────────────────── */
const loadedFaviconUrls = new Set<string>();

/* ─── Component ──────────────────────────────────────────────────────── */
export function ProjectFavicon(props: {
  readonly environmentId: EnvironmentId;
  readonly open?: boolean;
  readonly size?: number;
  readonly projectTitle: string;
  readonly workspaceRoot?: string | null;
}) {
  const size = props.size ?? 42;
  const faviconUrl = useAssetUrl(
    props.environmentId,
    props.workspaceRoot === null || props.workspaceRoot === undefined
      ? null
      : { _tag: "project-favicon", cwd: props.workspaceRoot },
  );
  const renderableFaviconUrl = isProjectFaviconFallbackUrl(faviconUrl) ? null : faviconUrl;

  return (
    <ProjectFaviconImage
      key={faviconUrl}
      faviconUrl={renderableFaviconUrl}
      open={props.open}
      projectTitle={props.projectTitle}
      size={size}
    />
  );
}

function ProjectFaviconImage(props: {
  readonly faviconUrl: string | null;
  readonly open?: boolean;
  readonly projectTitle: string;
  readonly size: number;
}) {
  const iconMuted = useThemeColor("--color-icon-subtle");

  const [status, setStatus] = useState<"loading" | "loaded" | "error">(() =>
    props.faviconUrl && loadedFaviconUrls.has(props.faviconUrl) ? "loaded" : "loading",
  );

  const showImage = props.faviconUrl !== null && status === "loaded";

  return (
    <View
      style={{
        width: props.size,
        height: props.size,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {/* Folder icon fallback (matches web's FolderIcon) */}
      {!showImage ? (
        <SymbolView
          name={{ ios: "folder.fill", android: props.open ? "folder_open" : "folder" }}
          size={props.size * 0.78}
          tintColor={iconMuted}
          type="monochrome"
        />
      ) : null}

      {/* Favicon image (hidden until loaded) */}
      {props.faviconUrl ? (
        <Image
          source={{
            uri: props.faviconUrl,
          }}
          accessibilityLabel={`${props.projectTitle} favicon`}
          style={{
            width: props.size,
            height: props.size,
            borderRadius: props.size * 0.16,
            ...(showImage ? {} : { position: "absolute" as const, opacity: 0 }),
          }}
          contentFit="contain"
          onLoad={() => {
            if (props.faviconUrl) loadedFaviconUrls.add(props.faviconUrl);
            setStatus("loaded");
          }}
          onError={() => setStatus("error")}
        />
      ) : null}
    </View>
  );
}
