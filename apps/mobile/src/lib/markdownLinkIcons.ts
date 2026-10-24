import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import type { ImageSourcePropType } from "react-native";

// The native renderer draws a link's icon from an image, so a host's mark is a bundled image keyed
// by its definition's `icon`. A host without one keeps a plain link.
const SOURCE_CONTROL_LINK_ICON_SOURCES: Partial<Record<string, ImageSourcePropType>> = {
  github: require("../../assets/link-icons/github.png"),
};

export function markdownLinkIconSource(host: string): ImageSourcePropType | null {
  const icon = sourceControlClients.findByPublicDomain(host)?.icon;
  return (icon === undefined ? undefined : SOURCE_CONTROL_LINK_ICON_SOURCES[icon]) ?? null;
}
