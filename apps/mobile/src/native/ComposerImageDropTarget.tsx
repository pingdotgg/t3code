import { View, type ViewProps } from "react-native";

export interface ComposerImageDropTargetProps extends ViewProps {
  readonly enabled: boolean;
  readonly onImageLoadingChange: (loading: boolean) => void;
  readonly onDropImages: (uris: ReadonlyArray<string>) => void;
}

export function ComposerImageDropTarget({
  enabled: _enabled,
  onDropImages: _onDropImages,
  onImageLoadingChange: _onImageLoadingChange,
  ...props
}: ComposerImageDropTargetProps) {
  return <View {...props} />;
}
