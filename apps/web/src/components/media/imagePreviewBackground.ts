import * as Schema from "effect/Schema";
import type { CSSProperties } from "react";
import {
  readLocalStorageValue,
  useLocalStorage,
  writeLocalStorageValue,
} from "../../hooks/useLocalStorage";

const storageKey = "t3code:image-preview-background";
const backgroundSchema = Schema.Literals(["theme", "light", "dark", "checker"]);
type ImagePreviewBackground = typeof backgroundSchema.Type;

export const imagePreviewBackgroundOptions = [
  { value: "theme", label: "Theme" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "checker", label: "Checkerboard" },
] satisfies { value: ImagePreviewBackground; label: string }[];

export const imagePreviewBackgroundStyles: Record<ImagePreviewBackground, CSSProperties> = {
  theme: {},
  light: { backgroundColor: "#ffffff", backgroundImage: "none" },
  dark: { backgroundColor: "#18181b", backgroundImage: "none" },
  checker: {
    backgroundColor: "#ffffff",
    backgroundImage: "conic-gradient(#e4e4e7 25%, #ffffff 0 50%, #e4e4e7 0 75%, #ffffff 0)",
    backgroundSize: "24px 24px",
  },
};

export function useImagePreviewBackground() {
  return useLocalStorage<ImagePreviewBackground, ImagePreviewBackground>(
    storageKey,
    "theme",
    backgroundSchema,
  );
}

export function readImagePreviewBackground() {
  return readLocalStorageValue<ImagePreviewBackground, ImagePreviewBackground>(
    storageKey,
    "theme",
    backgroundSchema,
  );
}

export function setImagePreviewBackground(value: ImagePreviewBackground) {
  writeLocalStorageValue(storageKey, value, "theme", backgroundSchema);
}
