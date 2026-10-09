import { Platform } from "react-native";
// Android retains its existing navigator. The iOS file checks native availability.
export const NATIVE_WORKSPACE_COLUMNS_SUPPORTED = Platform.OS === "ios" && Platform.isPad;
