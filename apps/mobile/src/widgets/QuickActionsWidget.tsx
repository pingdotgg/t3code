import {
  AccessoryWidgetBackground,
  HStack,
  Image,
  Link,
  Spacer,
  Text,
  VStack,
  ZStack,
} from "@expo/ui/swift-ui";
import {
  accessibilityLabel,
  background,
  clipShape,
  containerBackground,
  font,
  foregroundStyle,
  frame,
  lineLimit,
  multilineTextAlignment,
  padding,
  resizable,
  widgetURL,
} from "@expo/ui/swift-ui/modifiers";
import { createWidget, type WidgetEnvironment } from "expo-widgets";

import type { QuickActionsProps } from "./quickActionsSnapshot";

type QuickActionsConfiguration = { action?: "new" | "last" };

export function QuickActionsWidget(
  publishedProps: Partial<QuickActionsProps> | undefined,
  environment: WidgetEnvironment<QuickActionsConfiguration | undefined>,
) {
  "widget";
  // The extension evaluates this function without the app's module scope.
  // Before the app's first publish, the embedded layout renders with no props.
  const props = publishedProps ?? {};
  const family = environment.widgetFamily;
  const isLightScheme = environment.colorScheme === "light";
  const primary = { type: "hierarchical", style: "primary" } as const;
  const secondary = { type: "hierarchical", style: "secondary" } as const;

  // Every build accepts the prod scheme as a link prefix.
  const newThreadUrl = props.newThreadUrl ?? "t3code://new";
  const lastThread = props.lastThread;
  const opensLastThread = environment.configuration?.action === "last";
  // Small and Lock Screen widgets have a single tap target.
  const tapUrl = opensLastThread ? lastThread?.url : newThreadUrl;

  if (family === "accessoryCircular") {
    return (
      <ZStack
        modifiers={[
          containerBackground("clear", "widget"),
          accessibilityLabel(opensLastThread ? "Last thread" : "New thread"),
          ...(tapUrl ? [widgetURL(tapUrl)] : []),
        ]}
      >
        <AccessoryWidgetBackground />
        <Image
          systemName={opensLastThread ? "clock.arrow.circlepath" : "square.and.pencil"}
          size={22}
        />
      </ZStack>
    );
  }

  // The template image ignores frame/foregroundStyle applied to itself; size
  // and tint it through a container the resizable image fills.
  const logo = (
    <HStack>
      <HStack modifiers={[frame({ width: 19.5, height: 13 }), foregroundStyle(primary)]}>
        <Image assetName="T3Mark" modifiers={[resizable()]} />
      </HStack>
      <Spacer minLength={0} />
    </HStack>
  );
  const lastThreadSummary = (
    <VStack alignment="leading" spacing={1}>
      <Text modifiers={[font({ weight: "medium", size: 11 }), foregroundStyle(secondary)]}>
        Last thread
      </Text>
      <Text
        modifiers={[
          font({ weight: "semibold", size: lastThread ? 14 : 12 }),
          foregroundStyle(lastThread ? primary : secondary),
          lineLimit(lastThread ? 2 : 3),
          multilineTextAlignment("leading"),
        ]}
      >
        {lastThread ? lastThread.title : "Open a thread in T3 Code to see it here"}
      </Text>
    </VStack>
  );
  const cardBackground = containerBackground(isLightScheme ? "#ffffff" : "#1c1c1e", "widget");

  if (family === "systemSmall") {
    return (
      <VStack
        alignment="leading"
        spacing={0}
        modifiers={[cardBackground, ...(tapUrl ? [widgetURL(tapUrl)] : [])]}
      >
        {logo}
        <Spacer minLength={6} />
        {lastThreadSummary}
        <Spacer minLength={6} />
        {tapUrl ? (
          <HStack
            alignment="center"
            spacing={5}
            modifiers={[
              padding({ horizontal: 10, vertical: 6 }),
              background({ type: "hierarchical", style: "quaternary" }),
              clipShape("capsule"),
            ]}
          >
            <Image
              systemName={opensLastThread ? "arrow.up.forward" : "square.and.pencil"}
              size={12}
              modifiers={[foregroundStyle(primary)]}
            />
            <Text
              modifiers={[
                font({ weight: "semibold", size: 12 }),
                foregroundStyle(primary),
                lineLimit(1),
              ]}
            >
              {opensLastThread ? "Open thread" : "New thread"}
            </Text>
          </HStack>
        ) : null}
      </VStack>
    );
  }

  const tile = (header: React.ReactElement | null, content: React.ReactElement) => (
    <VStack
      alignment="leading"
      spacing={0}
      modifiers={[
        padding({ all: 12 }),
        frame({ maxWidth: Infinity, maxHeight: Infinity, alignment: "leading" }),
        background({ type: "hierarchical", style: "quinary" }),
        clipShape("roundedRectangle", 14),
      ]}
    >
      {header}
      <Spacer minLength={6} />
      {content}
    </VStack>
  );
  const lastThreadTile = tile(null, lastThreadSummary);
  return (
    <HStack spacing={8} modifiers={[cardBackground]}>
      <Link destination={newThreadUrl}>
        {tile(
          logo,
          <VStack alignment="leading" spacing={4}>
            <Image
              systemName="square.and.pencil"
              size={22}
              modifiers={[foregroundStyle(primary)]}
            />
            <Text
              modifiers={[
                font({ weight: "semibold", size: 15 }),
                foregroundStyle(primary),
                lineLimit(1),
              ]}
            >
              New thread
            </Text>
          </VStack>,
        )}
      </Link>
      {lastThread ? <Link destination={lastThread.url}>{lastThreadTile}</Link> : lastThreadTile}
    </HStack>
  );
}

export default createWidget<Partial<QuickActionsProps>>("QuickActions", QuickActionsWidget);
