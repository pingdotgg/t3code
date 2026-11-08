import type { ImageSourcePropType } from "react-native";

export const SOURCE_CONTROL_LINK_ICON_SOURCES: Readonly<Record<string, ImageSourcePropType>> = {
  "azure-devops": require("../../assets/link-icons/azure-devops.png"),
  bitbucket: require("../../assets/link-icons/bitbucket.png"),
  forgejo: require("../../assets/link-icons/forgejo.png"),
  gitcafe: require("../../assets/link-icons/gitcafe.png"),
  github: require("../../assets/link-icons/github.png"),
  gitlab: require("../../assets/link-icons/gitlab.png"),
};
