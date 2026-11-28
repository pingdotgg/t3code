import * as Schema from "effect/Schema";
import { msg } from "gt-react";
import {
  readLocalStorageValue,
  useLocalStorage,
  writeLocalStorageValue,
} from "../../hooks/useLocalStorage";

const storageKey = "t3code:image-preview-background";
const backgroundSchema = Schema.Literals(["theme", "light", "dark", "checker"]);
type ImagePreviewBackground = typeof backgroundSchema.Type;

export const imagePreviewBackgroundOptions = [
  { value: "theme", label: msg("Theme", { $context: "image background follows the app theme" }) },
  { value: "light", label: msg("Light", { $context: "image background color" }) },
  { value: "dark", label: msg("Dark", { $context: "image background color" }) },
  { value: "checker", label: msg("Checkerboard") },
] satisfies { value: ImagePreviewBackground; label: string }[];

export const imagePreviewBackgroundClassNames: Record<ImagePreviewBackground, string> = {
  theme: "",
  light: "bg-[#ffffff] bg-none",
  dark: "bg-[#18181b] bg-none",
  checker:
    "bg-[#ffffff] bg-[conic-gradient(#e4e4e7_25%,#ffffff_0_50%,#e4e4e7_0_75%,#ffffff_0)] bg-size-[24px_24px]",
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
