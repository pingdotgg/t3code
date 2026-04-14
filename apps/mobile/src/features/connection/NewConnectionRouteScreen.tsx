import { CameraView, useCameraPermissions } from "expo-camera";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { SymbolView } from "expo-symbols";
import { useCallback, useEffect, useState } from "react";
import { Alert, Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useThemeColor } from "../../lib/useThemeColor";

import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import { ErrorBanner } from "../../components/ErrorBanner";
import { dismissRoute } from "../../lib/routes";
import { ConnectionSheetButton } from "./ConnectionSheetButton";
import { extractPairingUrlFromQrPayload } from "./pairing";
import { useRemoteConnections } from "../../state/use-remote-environment-registry";
import { buildPairingUrl, parsePairingUrl } from "./pairing";

export function NewConnectionRouteScreen() {
  const {
    connectionError,
    connectionPairingUrl,
    connectionState,
    onChangeConnectionPairingUrl,
    onConnectPress,
  } = useRemoteConnections();
  const router = useRouter();
  const params = useLocalSearchParams<{ mode?: string }>();
  const insets = useSafeAreaInsets();
  const [hostInput, setHostInput] = useState("");
  const [codeInput, setCodeInput] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [showScanner, setShowScanner] = useState(params.mode === "scan_qr");
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const [scannerLocked, setScannerLocked] = useState(false);

  const textColor = useThemeColor("--color-icon");
  const placeholderColor = useThemeColor("--color-placeholder");

  const connectDisabled =
    isSubmitting || connectionState === "connecting" || hostInput.trim().length === 0;

  useEffect(() => {
    const { host, code } = parsePairingUrl(connectionPairingUrl);
    setHostInput(host);
    setCodeInput(code);
  }, [connectionPairingUrl]);

  useEffect(() => {
    if (connectionError) {
      setIsSubmitting(false);
    }
  }, [connectionError]);

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

    Alert.alert("Camera access needed", "Allow camera access to scan a backend pairing QR code.");
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

  const handleSubmit = useCallback(async () => {
    setIsSubmitting(true);

    try {
      const pairingUrl = buildPairingUrl(hostInput, codeInput);
      onChangeConnectionPairingUrl(pairingUrl);
      await onConnectPress(pairingUrl);
      dismissRoute(router);
    } catch {
      setIsSubmitting(false);
    }
  }, [codeInput, hostInput, onChangeConnectionPairingUrl, onConnectPress, router]);

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      <Stack.Screen
        options={{
          title: showScanner ? "Scan QR Code" : "Add Backend",
          headerRight: () => (
            <Pressable
              className="h-10 w-10 items-center justify-center rounded-full border border-border bg-secondary"
              onPress={() => {
                if (showScanner) {
                  closeScanner();
                } else {
                  void openScanner();
                }
              }}
            >
              <SymbolView
                name={showScanner ? "xmark" : "qrcode.viewfinder"}
                size={showScanner ? 14 : 18}
                tintColor={textColor}
                type="monochrome"
                weight="semibold"
              />
            </Pressable>
          ),
        }}
      />

      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        style={{ flex: 1 }}
        contentContainerStyle={{
          paddingHorizontal: 20,
          paddingTop: 16,
          paddingBottom: Math.max(insets.bottom, 18) + 18,
        }}
      >
        <View collapsable={false} className="gap-5">
          {showScanner ? (
            cameraPermission?.granted ? (
              <View
                className="overflow-hidden rounded-[24px]"
                style={{ borderCurve: "continuous" }}
              >
                <CameraView
                  barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
                  onBarcodeScanned={handleQrScan}
                  style={{ aspectRatio: 1, width: "100%" }}
                />
              </View>
            ) : (
              <View
                className="items-center gap-3 rounded-[24px] bg-card px-5 py-8"
                style={{ borderCurve: "continuous" }}
              >
                <Text className="text-center text-[14px] leading-[20px] text-foreground-muted">
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
              <View collapsable={false} className="gap-1.5">
                <Text
                  className="text-[11px] font-t3-bold uppercase text-foreground-muted"
                  style={{ letterSpacing: 0.8 }}
                >
                  Host
                </Text>
                <TextInput
                  autoCapitalize="none"
                  autoCorrect={false}
                  keyboardType="url"
                  placeholder="192.168.1.100:8080"
                  placeholderTextColor={placeholderColor}
                  value={hostInput}
                  onChangeText={handleHostChange}
                  className="rounded-[14px] border border-input-border bg-input px-4 py-3.5 text-[15px] text-foreground"
                />
              </View>

              <View collapsable={false} className="gap-1.5">
                <Text
                  className="text-[11px] font-t3-bold uppercase text-foreground-muted"
                  style={{ letterSpacing: 0.8 }}
                >
                  Pairing code
                </Text>
                <TextInput
                  autoCapitalize="none"
                  autoCorrect={false}
                  placeholder="abc-123-xyz"
                  placeholderTextColor={placeholderColor}
                  value={codeInput}
                  onChangeText={handleCodeChange}
                  className="rounded-[14px] border border-input-border bg-input px-4 py-3.5 text-[15px] text-foreground"
                />
              </View>

              {connectionError ? <ErrorBanner message={connectionError} /> : null}

              <ConnectionSheetButton
                icon="plus"
                label={
                  isSubmitting || connectionState === "connecting" ? "Pairing..." : "Add backend"
                }
                disabled={connectDisabled}
                tone="primary"
                onPress={() => {
                  void handleSubmit();
                }}
              />
            </View>
          )}
        </View>
      </ScrollView>
    </View>
  );
}
