import { SymbolView } from "expo-symbols";
import { useState } from "react";
import { Image, View } from "react-native";
import { useThemeColor } from "../lib/useThemeColor";

/* ─── Favicon cache (matches web pattern) ────────────────────────────── */
const loadedFaviconUrls = new Set<string>();

/* ─── Component ──────────────────────────────────────────────────────── */
export function ProjectFavicon(props: {
  readonly size?: number;
  readonly projectTitle: string;
  readonly httpBaseUrl?: string | null;
  readonly workspaceRoot?: string | null;
  readonly bearerToken?: string | null;
}) {
  const size = props.size ?? 42;
  const iconMuted = useThemeColor("--color-icon-subtle");

  const faviconUrl =
    props.httpBaseUrl && props.workspaceRoot
      ? `${props.httpBaseUrl}/api/project-favicon?cwd=${encodeURIComponent(props.workspaceRoot)}`
      : null;

  const [status, setStatus] = useState<"loading" | "loaded" | "error">(() =>
    faviconUrl && loadedFaviconUrls.has(faviconUrl) ? "loaded" : "loading",
  );

  const showImage = faviconUrl && status === "loaded";

  return (
    <View
      style={{
        width: size,
        height: size,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {/* Folder icon fallback (matches web's FolderIcon) */}
      {!showImage ? (
        <SymbolView name="folder.fill" size={size * 0.78} tintColor={iconMuted} type="monochrome" />
      ) : null}

      {/* Favicon image (hidden until loaded) */}
      {faviconUrl ? (
        <Image
          source={{
            uri: faviconUrl,
            ...(props.bearerToken
              ? { headers: { Authorization: `Bearer ${props.bearerToken}` } }
              : {}),
          }}
          style={{
            width: size,
            height: size,
            borderRadius: size * 0.16,
            ...(showImage ? {} : { position: "absolute" as const, opacity: 0 }),
          }}
          resizeMode="contain"
          onLoad={() => {
            if (faviconUrl) loadedFaviconUrls.add(faviconUrl);
            setStatus("loaded");
          }}
          onError={() => setStatus("error")}
        />
      ) : null}
    </View>
  );
}
