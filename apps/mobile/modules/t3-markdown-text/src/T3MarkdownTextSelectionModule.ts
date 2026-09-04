import { requireOptionalNativeModule } from "expo";

interface T3MarkdownTextSelectionNativeModule {
  readonly installCopySanitizer: (reactTag: number) => void;
}

const nativeModule =
  requireOptionalNativeModule<T3MarkdownTextSelectionNativeModule>("T3MarkdownTextSelection");

export function installMarkdownCopySanitizer(reactTag: number): void {
  nativeModule?.installCopySanitizer(reactTag);
}
