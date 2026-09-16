import { createContext, type RefObject } from "react";
import type { ViewInstance } from "react-native";

// Android cannot sample a target that contains the BlurView itself. Keep the
// feed in a separate target, shared by the composer and its popovers.
export const GlassBlurTargetContext = createContext<RefObject<ViewInstance | null> | undefined>(
  undefined,
);
