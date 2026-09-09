import { createContext, type RefObject } from "react";
import type { View } from "react-native";

// Android cannot sample a target that contains the BlurView itself. Keep the
// feed in a separate target, shared by the composer and its popovers.
export const GlassBlurTargetContext = createContext<RefObject<View | null> | undefined>(undefined);
