import { Modal, Pressable, ScrollView, View } from "react-native";
import { useColorScheme } from "react-native";

import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import { ErrorBanner } from "../../components/ErrorBanner";
import type { RemoteConnectionInput } from "../../lib/connection";
import type { RemoteClientConnectionState } from "../../lib/remoteClient";

export interface ConnectionSheetProps {
  readonly visible: boolean;
  readonly hasClient: boolean;
  readonly connectionInput: RemoteConnectionInput;
  readonly connectionState: RemoteClientConnectionState;
  readonly connectionError: string | null;
  readonly onRequestClose: () => void;
  readonly onChangeServerUrl: (serverUrl: string) => void;
  readonly onChangeAuthToken: (authToken: string) => void;
  readonly onConnect: () => void;
  readonly onClose: () => void;
  readonly onDisconnect: () => void;
  readonly onForgetSavedLink: () => void;
}

function makePalette(isDarkMode: boolean) {
  if (isDarkMode) {
    return {
      sheet: "#151618",
      panel: "#1d1e21",
      panelAlt: "#232529",
      rail: "#17181b",
      border: "rgba(255,255,255,0.08)",
      text: "#f4f3ef",
      muted: "#8f918f",
      tabActive: "#f1eee6",
      tabActiveText: "#18191b",
      tabInactive: "#24262a",
      tabInactiveText: "#73767c",
      input: "#1f2230",
      inputText: "#f8fafc",
      placeholder: "#6b7280",
      action: "#f97316",
      actionText: "#fff7ed",
      secondary: "#303440",
      secondaryText: "#f8fafc",
      danger: "#381624",
      dangerText: "#fda4af",
      utility: "#2a2d33",
      utilityText: "#f4f3ef",
      accent: "#d8b27a",
    };
  }

  return {
    sheet: "#f2ece4",
    panel: "#fbf7f1",
    panelAlt: "#f2ebe1",
    rail: "#ece4d8",
    border: "#d7cdbf",
    text: "#1f1b17",
    muted: "#847b71",
    tabActive: "#2c2a2d",
    tabActiveText: "#f8f4ee",
    tabInactive: "#ffffff",
    tabInactiveText: "#a89f94",
    input: "#ffffff",
    inputText: "#1f2937",
    placeholder: "#94a3b8",
    action: "#2c2a2d",
    actionText: "#f8f4ee",
    secondary: "#ffffff",
    secondaryText: "#1f1b17",
    danger: "#fde7e7",
    dangerText: "#a11d33",
    utility: "#e8dfd2",
    utilityText: "#1f1b17",
    accent: "#9a6b30",
  };
}

function FieldBlock(props: {
  readonly label: string;
  readonly placeholder: string;
  readonly value: string;
  readonly onChangeText: (value: string) => void;
  readonly palette: ReturnType<typeof makePalette>;
  readonly keyboardType?: "default" | "url";
}) {
  return (
    <View className="gap-2">
      <Text
        className="text-[11px] font-bold uppercase"
        style={{ color: props.palette.muted, letterSpacing: 1.15 }}
      >
        {props.label}
      </Text>
      <TextInput
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType={props.keyboardType}
        placeholder={props.placeholder}
        placeholderTextColor={props.palette.placeholder}
        className="min-h-[56px] px-4 py-3 text-[15px]"
        style={{
          borderWidth: 1,
          borderColor: props.palette.border,
          backgroundColor: props.palette.input,
          color: props.palette.inputText,
        }}
        value={props.value}
        onChangeText={props.onChangeText}
      />
    </View>
  );
}

function ActionButton(props: {
  readonly label: string;
  readonly onPress: () => void;
  readonly palette: ReturnType<typeof makePalette>;
  readonly tone?: "primary" | "secondary" | "danger" | "utility";
}) {
  const tone = props.tone ?? "secondary";
  const styles =
    tone === "primary"
      ? {
          backgroundColor: props.palette.action,
          color: props.palette.actionText,
        }
      : tone === "danger"
        ? {
            backgroundColor: props.palette.danger,
            color: props.palette.dangerText,
          }
        : tone === "utility"
          ? {
              backgroundColor: props.palette.utility,
              color: props.palette.utilityText,
            }
          : {
              backgroundColor: props.palette.secondary,
              color: props.palette.secondaryText,
            };

  return (
    <Pressable
      className="min-h-[52px] items-center justify-center px-4 py-3"
      style={{ backgroundColor: styles.backgroundColor }}
      onPress={props.onPress}
    >
      <Text
        className="text-sm font-extrabold uppercase"
        style={{ color: styles.color, letterSpacing: 1 }}
      >
        {props.label}
      </Text>
    </Pressable>
  );
}

export function ConnectionSheet(props: ConnectionSheetProps) {
  const isDarkMode = useColorScheme() === "dark";
  const palette = makePalette(isDarkMode);

  return (
    <Modal
      animationType="slide"
      presentationStyle="pageSheet"
      allowSwipeDismissal
      visible={props.visible}
      onRequestClose={props.onRequestClose}
    >
      <View className="flex-1" style={{ backgroundColor: palette.sheet }}>
        <ScrollView bounces={false} showsVerticalScrollIndicator={false}>
          <View className="gap-5 px-5 py-5">
            <View
              className="gap-4 px-4 py-4"
              style={{
                borderWidth: 1,
                borderColor: palette.border,
                backgroundColor: palette.panel,
              }}
            >
              <View className="flex-row items-start justify-between gap-4">
                <View className="flex-1 gap-2">
                  <Text
                    className="text-[11px] font-bold uppercase"
                    style={{ color: palette.accent, letterSpacing: 1.3 }}
                  >
                    Remote link
                  </Text>
                  <Text
                    className="text-[20px] font-extrabold leading-[24px]"
                    style={{ color: palette.text }}
                  >
                    Connect to a T3 server
                  </Text>
                  <Text className="text-[14px] leading-[20px]" style={{ color: palette.muted }}>
                    Use the same LAN or Tailnet URL you use for remote web access. The auth token is
                    optional unless the server was started with <Text>--auth-token</Text>.
                  </Text>
                </View>

                <View
                  className="px-3 py-2"
                  style={{
                    backgroundColor: props.hasClient ? palette.tabActive : palette.panelAlt,
                  }}
                >
                  <Text
                    className="text-[11px] font-bold uppercase"
                    style={{
                      color: props.hasClient ? palette.tabActiveText : palette.muted,
                      letterSpacing: 1.1,
                    }}
                  >
                    {props.hasClient ? "Saved link" : "Manual setup"}
                  </Text>
                </View>
              </View>

              <View className="gap-4">
                <FieldBlock
                  label="Server URL"
                  placeholder="http://192.168.1.42:3773"
                  value={props.connectionInput.serverUrl}
                  onChangeText={props.onChangeServerUrl}
                  keyboardType="url"
                  palette={palette}
                />

                <FieldBlock
                  label="Auth token"
                  placeholder="Paste the server token if required"
                  value={props.connectionInput.authToken}
                  onChangeText={props.onChangeAuthToken}
                  palette={palette}
                />
              </View>
            </View>

            {props.connectionError ? <ErrorBanner message={props.connectionError} /> : null}

            <View className="gap-3">
              <View className="flex-row gap-3">
                <View className="flex-1">
                  <ActionButton
                    label={props.connectionState === "connecting" ? "Connecting…" : "Connect"}
                    onPress={props.onConnect}
                    palette={palette}
                    tone="primary"
                  />
                </View>
                {props.hasClient ? (
                  <View className="flex-1">
                    <ActionButton
                      label="Close"
                      onPress={props.onClose}
                      palette={palette}
                      tone="secondary"
                    />
                  </View>
                ) : null}
              </View>

              {props.hasClient ? (
                <View className="flex-row gap-3">
                  <View className="flex-1">
                    <ActionButton
                      label="Disconnect"
                      onPress={props.onDisconnect}
                      palette={palette}
                      tone="danger"
                    />
                  </View>
                  <View className="flex-1">
                    <ActionButton
                      label="Forget saved link"
                      onPress={props.onForgetSavedLink}
                      palette={palette}
                      tone="utility"
                    />
                  </View>
                </View>
              ) : (
                <ActionButton
                  label="Forget saved link"
                  onPress={props.onForgetSavedLink}
                  palette={palette}
                  tone="utility"
                />
              )}
            </View>
          </View>
        </ScrollView>
      </View>
    </Modal>
  );
}
