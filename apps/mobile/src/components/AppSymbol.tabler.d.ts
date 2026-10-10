// Tabler 3.44 exports per-icon runtime modules but points their declarations at missing files.
declare module "@tabler/icons-react-native/Icon*" {
  import type { Icon } from "@tabler/icons-react-native";

  const icon: Icon;
  export default icon;
}
