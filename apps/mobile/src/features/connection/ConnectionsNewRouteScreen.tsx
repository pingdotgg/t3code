import { ScreenScrollView as ScrollView } from "../../components/ScreenScrollView";
import { CameraView, useCameraPermissions } from "expo-camera";
import { NativeHeaderToolbar, NativeStackScreenOptions } from "../../native/StackHeader";
import {
  StackActions,
  useNavigation,
  useRoute,
  type StaticScreenProps,
} from "@react-navigation/native";
import { AsyncResult } from "effect/unstable/reactivity";
import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, Linking, Platform, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useUniwindTheme } from "../../lib/useUniwindTheme";
import { SettingsScreen } from "../settings/components/SettingsScreen";
import { AppText as Text } from "../../components/AppText";
import { ErrorBanner } from "../../components/ErrorBanner";
import { ConnectionFormField } from "./ConnectionFormField";
import { ConnectionSheetButton } from "./ConnectionSheetButton";
import { buildPairingUrl, extractPairingUrlFromQrPayload, parsePairingUrl } from "./pairing";
import { useRemoteConnections } from "../../state/use-remote-environment-registry";

type ConnectionsNewRouteParams = {
  readonly mode?: string;
  readonly pairingUrl?: string;
  readonly autoConnect?: string;
};

export function ConnectionsNewRouteScreen({
  route,
}: StaticScreenProps<ConnectionsNewRouteParams | undefined>) {
  const {
    connectionPairingUrl,
    onChangeConnectionPairingUrl,
    onConnectPress,
    pairingConnectionError,
  } = useRemoteConnections();
  const navigation = useNavigation();
  const routeName = useRoute().name;
  const params = route.params ?? {};
  // Deep-link prefill exists for development automation only. A production
  // link must not arrive with attacker-chosen host and token already filled.
  const routePairingUrl = __DEV__ ? (params.pairingUrl?.trim() ?? "") : "";
  const shouldAutoConnect =
    __DEV__ &&
    routePairingUrl.length > 0 &&
    (params.autoConnect === "1" || params.autoConnect === "true");
  const insets = useSafeAreaInsets();
  const [hostInput, setHostInput] = useState("");
  const [codeInput, setCodeInput] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [showScanner, setShowScanner] = useState(params.mode === "scan_qr");
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const [scannerLocked, setScannerLocked] = useState(false);
  const attemptedAutoConnectRef = useRef<string | null>(null);

  const headerIconColor = useUniwindTheme()["--color-icon"];

  const connectDisabled = isSubmitting || hostInput.trim().length === 0;

  useEffect(() => {
    const { host, code } = parsePairingUrl(connectionPairingUrl);
    setHostInput(host);
    setCodeInput(code);
  }, [connectionPairingUrl]);

  useEffect(() => {
    if (routePairingUrl.length === 0) {
      return;
    }

    const { host, code } = parsePairingUrl(routePairingUrl);
    setHostInput(host);
    setCodeInput(code);
  }, [routePairingUrl]);

  useEffect(() => {
    if (pairingConnectionError) {
      setIsSubmitting(false);
    }
  }, [pairingConnectionError]);

  const handleHostChange = useCallback((value: string) => {
    setHostInput(value);
  }, []);

  const handleCodeChange = useCallback((value: string) => {
    setCodeInput(value);
  }, []);

  const openScanner = useCallback(async () => {
    if (cameraPermission?.granted) {
      setScannerLocked(false);
      setShowScanner(true);
      return;
    }

    const permission = await requestCameraPermission();
    if (permission.granted) {
      setScannerLocked(false);
      setShowScanner(true);
      return;
    }

    if (permission.canAskAgain) {
      Alert.alert(
        "Camera access needed",
        "Allow camera access to scan an environment pairing QR code.",
      );
      return;
    }

    Alert.alert(
      "Camera access needed",
      "Camera access was denied for this app. Open Settings to enable it.",
      [
        { text: "Cancel", style: "cancel" },
        { text: "Open Settings", onPress: () => void Linking.openSettings() },
      ],
    );
  }, [cameraPermission?.granted, requestCameraPermission]);

  const closeScanner = useCallback(() => {
    setShowScanner(false);
    setScannerLocked(false);
  }, []);

  const handleQrScan = useCallback(
    ({ data }: { readonly data: string }) => {
      if (scannerLocked) {
        return;
      }

      setScannerLocked(true);

      try {
        const pairingUrl = extractPairingUrlFromQrPayload(data);
        const { host, code } = parsePairingUrl(pairingUrl);
        setHostInput(host);
        setCodeInput(code);
        onChangeConnectionPairingUrl(pairingUrl);
        setShowScanner(false);
      } catch (error) {
        Alert.alert(
          "Invalid QR code",
          error instanceof Error ? error.message : "Scanned QR code was not recognized.",
        );
      } finally {
        setTimeout(() => {
          setScannerLocked(false);
        }, 600);
      }
    },
    [onChangeConnectionPairingUrl, scannerLocked],
  );

  const connectAndClose = useCallback(
    async (pairingUrl: string, replaceWithHome: boolean) => {
      setIsSubmitting(true);
      onChangeConnectionPairingUrl(pairingUrl);
      try {
        const result = await onConnectPress(pairingUrl);
        if (AsyncResult.isSuccess(result)) {
          if (replaceWithHome || !navigation.canGoBack()) {
            navigation.dispatch(StackActions.replace("Home"));
          } else {
            navigation.goBack();
          }
        }
      } finally {
        setIsSubmitting(false);
      }
    },
    [navigation, onChangeConnectionPairingUrl, onConnectPress],
  );

  const handleSubmit = useCallback(async () => {
    await connectAndClose(buildPairingUrl(hostInput, codeInput), false);
  }, [codeInput, connectAndClose, hostInput]);

  useEffect(() => {
    if (!shouldAutoConnect || attemptedAutoConnectRef.current === routePairingUrl) {
      return;
    }

    attemptedAutoConnectRef.current = routePairingUrl;
    void connectAndClose(routePairingUrl, true);
  }, [connectAndClose, routePairingUrl, shouldAutoConnect]);

  return (
    <SettingsScreen
      formSheet={routeName === "ConnectionsNew"}
      title={showScanner ? "Scan QR Code" : "Add Environment"}
      actions={[
        {
          accessibilityLabel: showScanner ? "Close scanner" : "Scan QR code",
          icon: showScanner ? "xmark" : "camera",
          onPress: () => {
            if (showScanner) {
              closeScanner();
            } else {
              void openScanner();
            }
          },
        },
      ]}
    >
      <NativeStackScreenOptions
        options={{ title: showScanner ? "Scan QR Code" : "Add Environment" }}
      />
      {Platform.OS !== "android" ? (
        <NativeHeaderToolbar placement="right">
          <NativeHeaderToolbar.Button
            icon={showScanner ? "xmark" : "qrcode.viewfinder"}
            onPress={() => {
              if (showScanner) {
                closeScanner();
              } else {
                void openScanner();
              }
            }}
            separateBackground
            tintColor={headerIconColor}
          />
        </NativeHeaderToolbar>
      ) : null}

      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentInset={{ bottom: Math.max(insets.bottom, 18) + 18 }}
        contentContainerStyle={{
          paddingHorizontal: 20,
          paddingTop: 16,
        }}
      >
        <View collapsable={false} className="gap-5">
          {showScanner ? (
            cameraPermission?.granted ? (
              <View className="overflow-hidden rounded-[24px] border-continuous">
                <CameraView
                  barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
                  onBarcodeScanned={handleQrScan}
                  style={{ aspectRatio: 1, width: "100%" }}
                />
              </View>
            ) : (
              <View className="items-center gap-3 rounded-[24px] border-continuous bg-card px-5 py-8">
                <Text className="text-center text-sm leading-normal text-foreground-muted">
                  Camera permission is required to scan a QR code.
                </Text>
                <ConnectionSheetButton
                  compact
                  icon="camera"
                  label="Allow camera"
                  tone="secondary"
                  onPress={() => {
                    void openScanner();
                  }}
                />
              </View>
            )
          ) : (
            <View collapsable={false} className="gap-4 rounded-[24px] bg-card p-4">
              <ConnectionFormField
                label="Host"
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="url"
                placeholder="192.168.1.100:8080"
                value={hostInput}
                onChangeText={handleHostChange}
              />

              <ConnectionFormField
                label="Pairing code"
                autoCapitalize="none"
                autoCorrect={false}
                placeholder="abc-123-xyz"
                value={codeInput}
                onChangeText={handleCodeChange}
              />

              {pairingConnectionError ? <ErrorBanner message={pairingConnectionError} /> : null}

              <View className={Platform.OS === "android" ? "flex-row justify-end" : undefined}>
                <ConnectionSheetButton
                  icon="plus"
                  label={isSubmitting ? "Pairing..." : "Add environment"}
                  disabled={connectDisabled}
                  tone="primary"
                  onPress={() => {
                    void handleSubmit();
                  }}
                />
              </View>
            </View>
          )}
        </View>
      </ScrollView>
    </SettingsScreen>
  );
}
