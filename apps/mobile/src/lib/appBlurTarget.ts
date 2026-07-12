import { createRef } from "react";
import type { View } from "react-native";

// Android BlurViews can't sample their real backdrop like iOS does — they
// need an explicit BlurTargetView to snapshot. App.tsx wraps the app content
// in one and binds this ref so overlays hosted in separate windows (the
// anchored dropdown's Modal) can still blur what's on screen behind them.
export const appBlurTargetRef = createRef<View>();
