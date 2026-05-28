import { useAuth, useUser, useUserProfileModal } from "@clerk/expo";
import { RELAY_CLERK_TOKEN_OPTIONS } from "@t3tools/shared/relayAuth";
import Constants from "expo-constants";
import { Stack, useRouter } from "expo-router";
import * as Effect from "effect/Effect";
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, View } from "react-native";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  cloudEnvironmentsPendingStatus,
  type CloudEnvironmentRecordWithStatus,
  connectCloudEnvironment,
  linkEnvironmentToCloud,
  listCloudEnvironments,
  loadCloudEnvironmentStatuses,
} from "../features/cloud/linkEnvironment";
import { useNativeClerkAuthModal } from "../features/cloud/useNativeClerkAuthModal";
import { mobileRuntime } from "../lib/runtime";
import { useThemeColor } from "../lib/useThemeColor";
import {
  connectSavedEnvironment,
  useRemoteEnvironmentState,
} from "../state/use-remote-environment-registry";

function readClerkPublishableKey(): string | null {
  const clerkConfig = Constants.expoConfig?.extra?.clerk as
    | { readonly publishableKey?: string | null }
    | undefined;
  return clerkConfig?.publishableKey ?? null;
}

function cloudErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

export function ErrorBoundary(props: { readonly error: Error; readonly retry: () => void }) {
  const router = useRouter();
  const colors = useCloudColors();

  return (
    <View style={[styles.screen, { backgroundColor: colors.sheet }]}>
      <Stack.Screen options={{ title: "T3 Cloud" }} />
      <CloudSheetHeader title="T3 Cloud" onClose={() => router.back()} />
      <View
        style={[styles.card, { backgroundColor: colors.danger, borderColor: colors.dangerBorder }]}
      >
        <Text style={[styles.cardTitle, { color: colors.dangerForeground }]}>
          Cloud sign-in crashed
        </Text>
        <Text style={[styles.bodyText, { color: colors.dangerForeground }]} selectable>
          {props.error.message}
        </Text>
        <Pressable
          accessibilityRole="button"
          onPress={props.retry}
          style={[styles.primaryButton, { backgroundColor: colors.primary }]}
        >
          <Text style={[styles.buttonText, { color: colors.primaryForeground }]}>Try again</Text>
        </Pressable>
      </View>
    </View>
  );
}

export default function CloudRoute() {
  const publishableKey = readClerkPublishableKey();
  if (!publishableKey) {
    return <CloudNotConfigured />;
  }

  return <CloudRouteInner />;
}

function CloudNotConfigured() {
  const router = useRouter();
  const colors = useCloudColors();
  const closeSheet = useCloseSheet(router);

  return (
    <View style={[styles.screen, { backgroundColor: colors.sheet }]}>
      <Stack.Screen options={{ title: "T3 Cloud" }} />
      <CloudSheetHeader title="T3 Cloud" onClose={closeSheet} />
      <View style={styles.centerContent}>
        <Text style={[styles.titleText, { color: colors.foreground, textAlign: "center" }]}>
          T3 Cloud is not configured
        </Text>
        <Text style={[styles.bodyText, { color: colors.secondaryForeground, textAlign: "center" }]}>
          Add EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY to this build to enable T3 Cloud sign-in.
        </Text>
      </View>
    </View>
  );
}

function CloudRouteInner() {
  const router = useRouter();
  const { getToken, isLoaded, isSignedIn } = useAuth({ treatPendingAsSignedOut: false });
  const getTokenRef = useRef(getToken);
  getTokenRef.current = getToken;
  const { user } = useUser();
  const { presentAuth } = useNativeClerkAuthModal();
  const { isAvailable: isUserProfileModalAvailable, presentUserProfile } = useUserProfileModal();
  const { savedConnectionsById } = useRemoteEnvironmentState();
  const colors = useCloudColors();
  const closeSheet = useCloseSheet(router);
  const [isLinking, setIsLinking] = useState(false);
  const [cloudEnvironments, setCloudEnvironments] = useState<
    ReadonlyArray<CloudEnvironmentRecordWithStatus>
  >([]);
  const [isLoadingCloudEnvironments, setIsLoadingCloudEnvironments] = useState(false);
  const [connectingEnvironmentId, setConnectingEnvironmentId] = useState<string | null>(null);
  const connections = Object.values(savedConnectionsById);

  useEffect(() => {
    if (__DEV__) {
      console.log("[cloud] auth state", { isLoaded, isSignedIn });
    }
  }, [isLoaded, isSignedIn]);

  const loadCloudEnvironments = useCallback(async () => {
    const token = await getTokenRef.current(RELAY_CLERK_TOKEN_OPTIONS);
    if (!token) {
      return;
    }
    const environments = await mobileRuntime.runPromise(
      listCloudEnvironments({ clerkToken: token }),
    );
    setCloudEnvironments(cloudEnvironmentsPendingStatus(environments));
    const records = await mobileRuntime.runPromise(
      loadCloudEnvironmentStatuses({ clerkToken: token, environments }),
    );
    setCloudEnvironments(records);
  }, []);

  const linkEnvironments = async () => {
    setIsLinking(true);
    try {
      const token = await getToken(RELAY_CLERK_TOKEN_OPTIONS);
      if (!token) {
        Alert.alert("Sign in required", "Sign in to T3 Cloud before linking environments.");
        return;
      }

      await mobileRuntime.runPromise(
        Effect.all(
          connections.map((connection) =>
            linkEnvironmentToCloud({ clerkToken: token, connection }),
          ),
          { concurrency: "unbounded" },
        ),
      );
      await loadCloudEnvironments();
      Alert.alert(
        "Environments linked",
        `${connections.length} environment${connections.length === 1 ? "" : "s"} linked to T3 Cloud.`,
      );
    } catch (error) {
      Alert.alert(
        "Link failed",
        cloudErrorMessage(error, "Could not link environments to T3 Cloud."),
      );
    } finally {
      setIsLinking(false);
    }
  };

  const refreshCloudEnvironments = useCallback(async () => {
    setIsLoadingCloudEnvironments(true);
    try {
      await loadCloudEnvironments();
    } catch (error) {
      Alert.alert(
        "Cloud environments unavailable",
        cloudErrorMessage(error, "Could not load linked environments."),
      );
    } finally {
      setIsLoadingCloudEnvironments(false);
    }
  }, [loadCloudEnvironments]);

  const connectCloudEnvironmentRecord = async (record: CloudEnvironmentRecordWithStatus) => {
    setConnectingEnvironmentId(record.environment.environmentId);
    try {
      if (record.status?.status === "offline") {
        Alert.alert(
          "Environment offline",
          record.status?.error ?? "This environment did not respond to a signed health check.",
        );
        return;
      }

      const token = await getToken(RELAY_CLERK_TOKEN_OPTIONS);
      if (!token) {
        Alert.alert("Sign in required", "Sign in to T3 Cloud before connecting environments.");
        return;
      }
      const connection = await mobileRuntime.runPromise(
        connectCloudEnvironment({
          clerkToken: token,
          environment: record.environment,
        }).pipe(Effect.tap(connectSavedEnvironment)),
      );
      Alert.alert("Environment connected", `${connection.environmentLabel} is ready.`);
    } catch (error) {
      Alert.alert(
        "Connect failed",
        cloudErrorMessage(error, "Could not connect to this environment."),
      );
    } finally {
      setConnectingEnvironmentId(null);
    }
  };

  useEffect(() => {
    if (isSignedIn) {
      void refreshCloudEnvironments();
    }
  }, [isSignedIn, refreshCloudEnvironments]);

  if (!isLoaded) {
    return (
      <View style={[styles.screen, { backgroundColor: colors.sheet }]}>
        <Stack.Screen options={{ title: "T3 Cloud" }} />
        <CloudSheetHeader title="T3 Cloud" onClose={closeSheet} />
        <View style={styles.centerContent}>
          <ActivityIndicator color={colors.icon} />
          <Text style={[styles.bodyText, { color: colors.secondaryForeground }]}>
            Loading T3 Cloud...
          </Text>
        </View>
      </View>
    );
  }

  if (!isSignedIn) {
    return (
      <View style={[styles.screen, { backgroundColor: colors.sheet }]}>
        <Stack.Screen options={{ title: "T3 Cloud" }} />
        <CloudSheetHeader title="Sign in to T3 Cloud" onClose={closeSheet} />
        <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <Text style={[styles.cardTitle, { color: colors.foreground }]}>
            Stay local by default
          </Text>
          <Text style={[styles.bodyText, { color: colors.secondaryForeground }]}>
            T3 Code works fully without signing in. T3 Cloud adds Live Activity updates and future
            device-to-device features.
          </Text>
          <Pressable
            accessibilityRole="button"
            onPress={() => void presentAuth()}
            style={[styles.primaryButton, { backgroundColor: colors.primary }]}
          >
            <Text style={[styles.buttonText, { color: colors.primaryForeground }]}>Sign in</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  return (
    <View collapsable={false} style={[styles.screen, { backgroundColor: colors.sheet }]}>
      <Stack.Screen options={{ title: "T3 Cloud" }} />
      <View style={styles.headerRow}>
        <View style={styles.headerTextColumn}>
          <Text style={[styles.titleText, { color: colors.foreground }]}>T3 Cloud</Text>
          <Text style={[styles.bodyText, { color: colors.secondaryForeground }]} selectable>
            {user?.primaryEmailAddress?.emailAddress ?? "Signed in"}
          </Text>
        </View>
        <Pressable
          accessibilityLabel="Manage T3 Cloud account"
          accessibilityRole="button"
          onPress={() => {
            if (isUserProfileModalAvailable) {
              void presentUserProfile();
            }
          }}
          style={[styles.avatarButton, { backgroundColor: colors.primary }]}
        >
          <Text style={[styles.buttonText, { color: colors.primaryForeground }]}>
            {user?.firstName?.charAt(0).toUpperCase() ??
              user?.primaryEmailAddress?.emailAddress.charAt(0).toUpperCase() ??
              "T"}
          </Text>
        </Pressable>
      </View>

      <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
        <Text style={[styles.cardTitle, { color: colors.foreground }]}>Linked environments</Text>
        <Text style={[styles.bodyText, { color: colors.secondaryForeground }]}>
          Link this device to your connected environments so relay can deliver Live Activity
          updates.
        </Text>
        <Pressable
          accessibilityRole="button"
          disabled={isLinking || connections.length === 0}
          onPress={() => void linkEnvironments()}
          style={[
            styles.primaryButton,
            {
              backgroundColor: colors.primary,
              opacity: isLinking || connections.length === 0 ? 0.4 : 1,
            },
          ]}
        >
          <Text style={[styles.buttonText, { color: colors.primaryForeground }]}>
            {isLinking
              ? "Linking..."
              : `Link ${connections.length} environment${connections.length === 1 ? "" : "s"}`}
          </Text>
        </Pressable>
      </View>

      <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
        <View style={styles.cardHeaderRow}>
          <Text style={[styles.cardTitle, { color: colors.foreground }]}>Cloud environments</Text>
          <Pressable
            accessibilityRole="button"
            disabled={isLoadingCloudEnvironments}
            onPress={() => void refreshCloudEnvironments()}
            style={[
              styles.smallButton,
              { backgroundColor: colors.secondary, borderColor: colors.secondaryBorder },
            ]}
          >
            <Text style={[styles.smallButtonText, { color: colors.secondaryButtonForeground }]}>
              {isLoadingCloudEnvironments ? "Loading" : "Refresh"}
            </Text>
          </Pressable>
        </View>
        {cloudEnvironments.length === 0 ? (
          <Text style={[styles.bodyText, { color: colors.secondaryForeground }]}>
            No linked cloud environments yet.
          </Text>
        ) : (
          cloudEnvironments.map((record) => {
            const { environment } = record;
            const isConnecting = connectingEnvironmentId === environment.environmentId;
            const isOffline = record.status?.status === "offline";
            const statusLabel =
              record.status === null
                ? "Status unavailable"
                : record.status.status === "online"
                  ? "Online"
                  : "Offline";
            return (
              <View
                key={environment.environmentId}
                style={[styles.environmentRow, { borderColor: colors.border }]}
              >
                <View style={styles.environmentTextColumn}>
                  <Text style={[styles.environmentTitle, { color: colors.foreground }]}>
                    {environment.label}
                  </Text>
                  <Text
                    style={[styles.environmentUrl, { color: colors.secondaryForeground }]}
                    numberOfLines={1}
                  >
                    {environment.endpoint.httpBaseUrl}
                  </Text>
                  <Text
                    style={[styles.environmentStatus, { color: colors.secondaryForeground }]}
                    numberOfLines={2}
                  >
                    {statusLabel}
                    {record.statusError ? ` - ${record.statusError}` : ""}
                    {record.status?.error ? ` - ${record.status.error}` : ""}
                  </Text>
                </View>
                <Pressable
                  accessibilityRole="button"
                  disabled={isConnecting || isOffline}
                  onPress={() => void connectCloudEnvironmentRecord(record)}
                  style={[
                    styles.smallPrimaryButton,
                    {
                      backgroundColor: colors.primary,
                      opacity: isOffline ? 0.45 : 1,
                    },
                  ]}
                >
                  <Text style={[styles.smallButtonText, { color: colors.primaryForeground }]}>
                    {isConnecting ? "Connecting" : "Connect"}
                  </Text>
                </Pressable>
              </View>
            );
          })
        )}
      </View>

      <Pressable
        accessibilityRole="button"
        onPress={() => {
          if (isUserProfileModalAvailable) {
            void presentUserProfile();
          }
        }}
        style={[
          styles.secondaryButton,
          { backgroundColor: colors.secondary, borderColor: colors.secondaryBorder },
        ]}
      >
        <Text style={[styles.buttonText, { color: colors.secondaryButtonForeground }]}>
          Manage account
        </Text>
      </Pressable>
    </View>
  );
}

function CloudSheetHeader(props: { readonly title: string; readonly onClose: () => void }) {
  const colors = useCloudColors();
  return (
    <View style={styles.sheetHeader}>
      <Text style={[styles.titleText, { color: colors.foreground, flex: 1 }]}>{props.title}</Text>
      <Pressable
        accessibilityLabel="Close T3 Cloud"
        accessibilityRole="button"
        onPress={props.onClose}
        style={[styles.closeButton, { backgroundColor: colors.subtle }]}
      >
        <Text style={[styles.closeButtonText, { color: colors.secondaryForeground }]}>Close</Text>
      </Pressable>
    </View>
  );
}

function useCloseSheet(router: ReturnType<typeof useRouter>) {
  return () => {
    if (router.canGoBack()) {
      router.back();
      return;
    }
    router.replace("/");
  };
}

function useCloudColors() {
  return {
    border: String(useThemeColor("--color-border")),
    card: String(useThemeColor("--color-card")),
    danger: String(useThemeColor("--color-danger")),
    dangerBorder: String(useThemeColor("--color-danger-border")),
    dangerForeground: String(useThemeColor("--color-danger-foreground")),
    foreground: String(useThemeColor("--color-foreground")),
    icon: String(useThemeColor("--color-icon")),
    primary: String(useThemeColor("--color-primary")),
    primaryForeground: String(useThemeColor("--color-primary-foreground")),
    secondary: String(useThemeColor("--color-secondary")),
    secondaryBorder: String(useThemeColor("--color-secondary-border")),
    secondaryButtonForeground: String(useThemeColor("--color-secondary-foreground")),
    secondaryForeground: String(useThemeColor("--color-foreground-secondary")),
    sheet: String(useThemeColor("--color-sheet")),
    subtle: String(useThemeColor("--color-subtle")),
  };
}

const styles = StyleSheet.create({
  avatarButton: {
    alignItems: "center",
    borderRadius: 22,
    height: 44,
    justifyContent: "center",
    width: 44,
  },
  bodyText: {
    fontFamily: "DMSans_400Regular",
    fontSize: 16,
    lineHeight: 22,
  },
  buttonText: {
    fontFamily: "DMSans_700Bold",
    fontSize: 16,
  },
  card: {
    borderCurve: "continuous",
    borderRadius: 28,
    borderWidth: 1,
    gap: 10,
    padding: 20,
  },
  cardHeaderRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: 12,
    justifyContent: "space-between",
  },
  cardTitle: {
    fontFamily: "DMSans_700Bold",
    fontSize: 18,
    lineHeight: 24,
  },
  centerContent: {
    alignItems: "center",
    flex: 1,
    gap: 16,
    justifyContent: "center",
    paddingHorizontal: 12,
  },
  closeButton: {
    alignItems: "center",
    borderRadius: 20,
    height: 40,
    justifyContent: "center",
    paddingHorizontal: 16,
  },
  closeButtonText: {
    fontFamily: "DMSans_700Bold",
    fontSize: 14,
  },
  contentContainer: {
    gap: 20,
    paddingBottom: 32,
    paddingHorizontal: 20,
    paddingTop: 16,
  },
  environmentRow: {
    alignItems: "center",
    borderRadius: 18,
    borderWidth: 1,
    flexDirection: "row",
    gap: 12,
    padding: 12,
  },
  environmentTextColumn: {
    flex: 1,
    gap: 2,
    minWidth: 0,
  },
  environmentTitle: {
    fontFamily: "DMSans_700Bold",
    fontSize: 14,
    lineHeight: 18,
  },
  environmentStatus: {
    fontFamily: "DMSans_700Bold",
    fontSize: 12,
    lineHeight: 16,
  },
  environmentUrl: {
    fontFamily: "DMSans_400Regular",
    fontSize: 12,
    lineHeight: 16,
  },
  headerRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: 12,
  },
  headerTextColumn: {
    flex: 1,
    gap: 4,
  },
  primaryButton: {
    alignItems: "center",
    borderRadius: 999,
    marginTop: 10,
    paddingHorizontal: 20,
    paddingVertical: 12,
  },
  root: {
    flex: 1,
  },
  screen: {
    flex: 1,
    gap: 16,
    paddingBottom: 20,
    paddingHorizontal: 20,
    paddingTop: 16,
  },
  secondaryButton: {
    alignItems: "center",
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: 20,
    paddingVertical: 12,
  },
  smallButton: {
    alignItems: "center",
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  smallButtonText: {
    fontFamily: "DMSans_700Bold",
    fontSize: 12,
  },
  smallPrimaryButton: {
    alignItems: "center",
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  sheetHeader: {
    alignItems: "center",
    flexDirection: "row",
    gap: 12,
    paddingBottom: 16,
  },
  titleText: {
    fontFamily: "DMSans_700Bold",
    fontSize: 22,
    lineHeight: 28,
  },
});
