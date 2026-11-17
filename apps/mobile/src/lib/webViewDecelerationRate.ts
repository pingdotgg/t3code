import { Platform } from "react-native";

// react-native-webview on Fabric leaves an unset rate at 0, which UIKit clamps to "fast"; Android crashes on the string.
export const webViewDecelerationRate = Platform.OS === "ios" ? "normal" : undefined;
