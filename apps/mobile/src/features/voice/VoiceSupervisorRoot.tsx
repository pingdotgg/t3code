import { useAtomValue } from "@effect/atom-react";
import { useNavigation } from "@react-navigation/native";
import { createContext, type ReactNode, useContext, useEffect, useRef, useState } from "react";
import { AccessibilityInfo, I18nManager, Pressable, useWindowDimensions, View } from "react-native";
import { useKeyboardState } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { OverlayPortal } from "../../components/OverlayPortal";
import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { cn } from "../../lib/cn";
import { useThemeColor } from "../../lib/useThemeColor";
import {
  createDefaultMobileVoiceSupervisorRuntime,
  type MobileVoiceSupervisorCompactState,
  type MobileVoiceSupervisorRuntime,
} from "../../voice/voiceSupervisorRuntime";
import {
  pendingMobileVoiceConfirmationAnnouncement,
  shouldShowVoiceForegroundButton,
  voiceForegroundButtonPosition,
  voiceForegroundButtonPresentation,
} from "./voiceSupervisorPresentation";

const VoiceSupervisorRuntimeContext = createContext<MobileVoiceSupervisorRuntime | null>(null);

export function useMobileVoiceSupervisorRuntime(): MobileVoiceSupervisorRuntime {
  const runtime = useContext(VoiceSupervisorRuntimeContext);
  if (runtime === null) {
    throw new Error("Voice Supervisor must be rendered inside VoiceSupervisorRoot.");
  }
  return runtime;
}

export function VoiceForegroundButton(props: {
  readonly compact: MobileVoiceSupervisorCompactState;
  readonly routeVisible: boolean;
  readonly onOpen: () => void;
}) {
  const presentation = voiceForegroundButtonPresentation(props.compact);
  if (
    presentation === null ||
    !shouldShowVoiceForegroundButton(props.compact, props.routeVisible)
  ) {
    return null;
  }
  return <VisibleVoiceForegroundButton presentation={presentation} onOpen={props.onOpen} />;
}

function VisibleVoiceForegroundButton(props: {
  readonly presentation: NonNullable<ReturnType<typeof voiceForegroundButtonPresentation>>;
  readonly onOpen: () => void;
}) {
  const { presentation } = props;
  const insets = useSafeAreaInsets();
  const { height: windowHeight } = useWindowDimensions();
  const keyboardHeight = useKeyboardState((state) => (state.isVisible ? state.height : 0));
  const primaryIconColor = useThemeColor("--color-primary-foreground");
  const dangerIconColor = useThemeColor("--color-danger-foreground");
  const position = voiceForegroundButtonPosition({
    windowHeight,
    safeAreaTop: insets.top,
    safeAreaBottom: insets.bottom,
    safeAreaTrailing: I18nManager.isRTL ? insets.left : insets.right,
    keyboardHeight,
  });

  const iconColor =
    presentation.tone === "failed"
      ? dangerIconColor
      : presentation.tone === "muted" || presentation.tone === "pending"
        ? "#000000"
        : primaryIconColor;

  return (
    <OverlayPortal>
      <Pressable
        accessibilityLabel={presentation.label}
        accessibilityRole="button"
        accessibilityState={{ busy: presentation.tone === "connecting" }}
        onPress={props.onOpen}
        className={cn(
          "absolute size-11 items-center justify-center rounded-full border-2 border-sheet shadow-lg",
          presentation.tone === "listening" && "bg-emerald-600",
          presentation.tone === "connecting" && "bg-sky-600",
          (presentation.tone === "muted" || presentation.tone === "pending") && "bg-amber-600",
          presentation.tone === "failed" && "bg-danger",
        )}
        style={{
          top: position.top,
          ...(I18nManager.isRTL ? { left: position.trailing } : { right: position.trailing }),
        }}
      >
        <SymbolView name={presentation.icon} size={20} tintColor={iconColor} type="monochrome" />
        {presentation.pendingCount > 0 ? (
          <View
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            className="absolute -top-2 -left-2 min-w-5 rounded-full bg-amber-300 px-1 py-0.5"
          >
            <Text className="text-center text-2xs font-t3-bold text-black">
              {presentation.pendingCount}
            </Text>
          </View>
        ) : null}
      </Pressable>
    </OverlayPortal>
  );
}

export function VoiceSupervisorRoot(props: {
  readonly children: ReactNode;
  readonly topRouteName: string | undefined;
}) {
  const navigation = useNavigation();
  const navigationRef = useRef(navigation);
  navigationRef.current = navigation;
  const [runtime] = useState(() =>
    createDefaultMobileVoiceSupervisorRuntime({
      navigateThread: (params) => navigationRef.current.navigate("Thread", params),
    }),
  );
  const compact = useAtomValue(runtime.compactAtom);
  const routeVisible = props.topRouteName === "VoiceSupervisor";
  const lastAnnouncementRef = useRef<string | null>(null);
  const pendingAnnouncement = pendingMobileVoiceConfirmationAnnouncement(
    {
      count: compact.pendingConfirmationCount,
      summary: compact.pendingConfirmationSummary,
    },
    routeVisible,
  );

  useEffect(() => () => runtime.dispose(), [runtime]);

  useEffect(() => {
    if (pendingAnnouncement === null) {
      lastAnnouncementRef.current = null;
      return;
    }
    if (lastAnnouncementRef.current === pendingAnnouncement) return;
    lastAnnouncementRef.current = pendingAnnouncement;
    AccessibilityInfo.announceForAccessibility(pendingAnnouncement);
  }, [pendingAnnouncement]);

  return (
    <VoiceSupervisorRuntimeContext.Provider value={runtime}>
      {props.children}
      <VoiceForegroundButton
        compact={compact}
        routeVisible={routeVisible}
        onOpen={() => navigation.navigate("VoiceSupervisor")}
      />
    </VoiceSupervisorRuntimeContext.Provider>
  );
}
