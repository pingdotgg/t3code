import { SheetCloseButton } from "../../../components/ui/SheetHeader";
import { type NavigationProp, type ParamListBase, useNavigation } from "@react-navigation/native";
import { useCallback, useLayoutEffect, useState } from "react";
import { Linking, Pressable, View } from "react-native";
import { WebView } from "react-native-webview";

import { Button } from "../../../components/ui/Button";
import { IconButton } from "../../../components/ui/IconButton";
import { AppActivityIndicator } from "../../../components/ui/AppActivityIndicator";
import { AppText as Text } from "../../../components/ui/AppText";
import { LoadingStrip } from "../../../components/ui/LoadingStrip";
import { SymbolView } from "../../../components/ui/AppSymbol";
import { isLegalDocumentUrl, LEGAL_URL } from "../lib/legal-document-url";

export function SettingsLegalDocumentCloseHeaderButton() {
  const navigation = useNavigation();

  return (
    <SheetCloseButton
      accessibilityLabel="Close legal document"
      onClose={() => navigation.goBack()}
    />
  );
}

export function SettingsLegalDocumentExternalHeaderButton({
  externalUrl = LEGAL_URL,
}: {
  readonly externalUrl?: string;
}) {
  const safeExternalUrl = isLegalDocumentUrl(externalUrl) ? externalUrl : LEGAL_URL;

  return (
    <IconButton
      accessibilityLabel="Open legal documents in external browser"
      icon="safari"
      onPress={() => void Linking.openURL(safeExternalUrl).catch(() => undefined)}
    />
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
          tintColorClassName={"accent-icon"}
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
          <Button
            label="Try Again"
            tone="contrast"
            fullWidth
            onPress={() => {
              setLoadError(null);
              setReloadKey((value) => value + 1);
            }}
          />
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
            <AppActivityIndicator />
          </View>
        )}
        style={{ flex: 1, backgroundColor: "transparent" }}
      />
    </View>
  );
}
