import { requireOptionalNativeModule } from "expo";
import { Platform } from "react-native";
const nativeControls = requireOptionalNativeModule<{ readonly supportsWorkspaceColumns?: boolean }>(
  "T3NativeControls",
);
export const NATIVE_WORKSPACE_COLUMNS_SUPPORTED =
  Platform.OS === "ios" && (Platform.isPad || Number(Platform.Version) >= 27.1) && nativeControls?.supportsWorkspaceColumns === true;
