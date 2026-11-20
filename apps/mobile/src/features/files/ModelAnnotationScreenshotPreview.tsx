import { useGT } from "gt-react-native";
import { createContext, use, type ComponentProps } from "react";
import { View } from "react-native";
import ImageViewing from "react-native-image-viewing";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useResolveClassNames } from "uniwind";

import { SheetHeader } from "../../components/ui/SheetHeader";
import type { MediaActionsSource } from "../../lib/mediaActionsSource";
import { useMediaActions } from "../../state/mediaActions";

interface ScreenshotPreviewProps {
  readonly uri: string;
  readonly name: string;
  readonly actionsSource?: MediaActionsSource;
  readonly onClose: () => void;
}

const ScreenshotPreviewContext = createContext<ScreenshotPreviewProps | null>(null);

function ScreenshotPreviewHeader() {
  const props = use(ScreenshotPreviewContext)!;
  const gt = useGT();
  const insets = useSafeAreaInsets();
  const media = useMediaActions(props.actionsSource);
  const save = media.actions.find((action) => action.id === "save");
  const actions: ComponentProps<typeof SheetHeader>["actions"] = save
    ? [
        {
          accessibilityLabel: gt("Save or share"),
          icon: "square.and.arrow.up",
          disabled: save.disabled,
          loading: media.sharing,
          onPress: () => void save.run(),
        },
      ]
    : [];
  return (
    <View className="bg-sheet" style={{ paddingTop: insets.top }}>
      <SheetHeader
        presentation="inline"
        title={props.name}
        onClose={props.onClose}
        actions={actions}
      />
    </View>
  );
}

/** The transparent PNG keeps the app's screenshot background when opened at full size. */
export function ModelAnnotationScreenshotPreview(props: ScreenshotPreviewProps) {
  const { backgroundColor } = useResolveClassNames("bg-grouped-card");
  return (
    <ScreenshotPreviewContext value={props}>
      <ImageViewing
        images={[{ uri: props.uri }]}
        imageIndex={0}
        visible
        presentationStyle="fullScreen"
        {...(typeof backgroundColor === "string" ? { backgroundColor } : {})}
        onRequestClose={props.onClose}
        swipeToCloseEnabled={false}
        doubleTapToZoomEnabled
        HeaderComponent={ScreenshotPreviewHeader}
      />
    </ScreenshotPreviewContext>
  );
}
