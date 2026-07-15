import { type NavigationProp, type ParamListBase, useNavigation } from "@react-navigation/native";
import { useCallback, useLayoutEffect, useState } from "react";
import { ActivityIndicator, Linking, Pressable, View } from "react-native";
import { WebView } from "react-native-webview";

import { AppText as Text } from "../../../components/AppText";
import { LoadingStrip } from "../../../components/LoadingStrip";
import { SymbolView } from "../../../components/AppSymbol";
import { useThemeColor } from "../../../lib/useThemeColor";
import { isLegalDocumentUrl, LEGAL_URL } from "../lib/legal-document-url";

export function SettingsLegalDocumentCloseHeaderButton() {
  const navigation = useNavigation();
  const iconColor = useThemeColor("--color-icon");

  return (
    <Pressable
      accessibilityLabel="Close legal document"
      accessibilityRole="button"
      hitSlop={12}
      onPress={() => navigation.goBack()}
      className="p-2 active:opacity-60"
    >
      <SymbolView
        name="xmark"
        size={18}
        tintColor={iconColor}
        type="monochrome"
        weight="semibold"
      />
    </Pressable>
  );
}

export function SettingsLegalDocumentExternalHeaderButton({
  externalUrl = LEGAL_URL,
}: {
  readonly externalUrl?: string;
}) {
  const iconColor = useThemeColor("--color-icon");
  const safeExternalUrl = isLegalDocumentUrl(externalUrl) ? externalUrl : LEGAL_URL;

  return (
    <Pressable
      accessibilityLabel="Open legal documents in external browser"
      accessibilityRole="button"
      hitSlop={12}
      onPress={() => void Linking.openURL(safeExternalUrl).catch(() => undefined)}
      className="p-2 active:opacity-60"
    >
      <SymbolView
        name="safari"
        size={19}
        tintColor={iconColor}
        type="monochrome"
        weight="regular"
      />
    </Pressable>
  );
}

interface SettingsLegalDocumentRouteScreenProps {
  readonly documentName: string;
  readonly documentUrl: string;
}

export function SettingsLegalDocumentRouteScreen({
  documentName,
  documentUrl,
}: SettingsLegalDocumentRouteScreenProps) {
  const navigation = useNavigation<NavigationProp<ParamListBase>>();
  const iconColor = useThemeColor("--color-icon");
  const [reloadKey, setReloadKey] = useState(0);
  const [loadProgress, setLoadProgress] = useState(0);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [externalUrl, setExternalUrl] = useState(documentUrl);
  const renderExternalHeaderButton = useCallback(
    () => <SettingsLegalDocumentExternalHeaderButton externalUrl={externalUrl} />,
    [externalUrl],
  );

  useLayoutEffect(() => {
    navigation.setOptions({
      headerRight: renderExternalHeaderButton,
    });
  }, [navigation, renderExternalHeaderButton]);

  const openExternalUrl = useCallback((url: string) => {
    void Linking.openURL(url).catch(() => undefined);
  }, []);
  if (loadError) {
    return (
      <View className="flex-1 items-center justify-center gap-4 bg-sheet px-8">
        <SymbolView
          name="exclamationmark.triangle"
          size={32}
          tintColor={iconColor}
          type="monochrome"
          weight="regular"
        />
        <View className="items-center gap-2">
          <Text className="text-center font-t3-bold text-lg text-foreground">
            Couldn&apos;t load the {documentName.toLowerCase()}
          </Text>
          <Text selectable className="text-center text-sm leading-normal text-foreground-muted">
            {loadError}
          </Text>
        </View>
        <View className="w-full max-w-[320px] gap-2">
          <Pressable
            accessibilityRole="button"
            onPress={() => {
              setLoadError(null);
              setReloadKey((value) => value + 1);
            }}
            className="items-center rounded-xl bg-foreground px-4 py-3 active:opacity-80"
          >
            <Text className="font-t3-bold text-base text-sheet">Try Again</Text>
          </Pressable>
          <Pressable
            accessibilityRole="link"
            onPress={() => openExternalUrl(documentUrl)}
            className="items-center rounded-xl px-4 py-3 active:bg-foreground/5"
          >
            <Text className="font-t3-medium text-base text-foreground-muted">Open in Browser</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  return (
    <View className="relative flex-1 bg-sheet">
      {loadProgress > 0 && loadProgress < 1 ? <LoadingStrip progress={loadProgress} /> : null}
      <WebView
        key={reloadKey}
        source={{ uri: documentUrl }}
        originWhitelist={["http://*", "https://*", "mailto:*"]}
        cacheEnabled={false}
        cacheMode="LOAD_NO_CACHE"
        allowsBackForwardNavigationGestures
        domStorageEnabled={false}
        incognito
        javaScriptEnabled={false}
        setSupportMultipleWindows={false}
        sharedCookiesEnabled={false}
        thirdPartyCookiesEnabled={false}
        startInLoadingState
        onShouldStartLoadWithRequest={(request) => {
          if (isLegalDocumentUrl(request.url)) return true;

          openExternalUrl(request.url);
          return false;
        }}
        onLoadProgress={(event) => {
          setLoadProgress(event.nativeEvent.progress);
        }}
        onLoadStart={() => {
          setLoadProgress(0.05);
          setLoadError(null);
        }}
        onLoadEnd={(event) => {
          if (isLegalDocumentUrl(event.nativeEvent.url)) {
            setExternalUrl(event.nativeEvent.url);
          }
          setLoadProgress(0);
        }}
        onError={(event) => {
          setLoadProgress(0);
          setLoadError(event.nativeEvent.description || "The page could not be loaded.");
        }}
        onHttpError={(event) => {
          if (!isLegalDocumentUrl(event.nativeEvent.url)) return;
          setLoadProgress(0);
          setLoadError(`The server returned status ${event.nativeEvent.statusCode}.`);
        }}
        renderLoading={() => (
          <View className="absolute inset-0 items-center justify-center bg-sheet">
            <ActivityIndicator />
          </View>
        )}
        style={{ flex: 1, backgroundColor: "transparent" }}
      />
    </View>
  );
}
