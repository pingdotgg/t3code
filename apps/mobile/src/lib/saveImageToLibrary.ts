import { requireNativeModule } from "expo";
import { Platform } from "react-native";

const SAVABLE_IMAGE_MIME_TYPE = /^image\/(png|jpe?g|gif|webp|heic|heif)$/i;

function baseMimeType(mimeType: string): string {
  return mimeType.split(";", 1)[0]?.trim() ?? "";
}

// Android 9 and older need a storage permission to add photos, so they keep the share sheet.
export function canSaveImageToLibrary(mimeType: string): boolean {
  return (
    SAVABLE_IMAGE_MIME_TYPE.test(baseMimeType(mimeType)) &&
    (Platform.OS === "ios" || (Platform.OS === "android" && Platform.Version >= 29))
  );
}

/** Adds a local image file to Photos on iOS or Pictures/T3 Code on Android. */
export function saveImageToLibrary(uri: string, mimeType: string, name: string): Promise<void> {
  return requireNativeModule<{
    saveImageToLibrary(uri: string, mimeType: string, name: string): Promise<void>;
  }>("T3NativeControls").saveImageToLibrary(uri, baseMimeType(mimeType), name);
}
