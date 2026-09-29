import { ConnectionTraceId } from "./ConnectionTraceId";
import {
  type EnvironmentConnectionPhase,
  type EnvironmentConnectionPresentation,
} from "@t3tools/client-runtime/connection";
import { SymbolView } from "../../components/AppSymbol";
import { translate } from "@t3tools/i18n";
import { useTranslation } from "@t3tools/i18n/react";
import { ActivityIndicator, Pressable, View } from "react-native";

import { AppText as Text } from "../../components/AppText";

function noticeTitle(phase: EnvironmentConnectionPhase, environmentLabel: string): string {
  switch (phase) {
    case "offline":
      return translate("common:mobileConnections.offline", "You are offline");
    case "connecting":
      return translate("common:mobileConnections.connecting", "Connecting to {{environment}}…", {
        environment: environmentLabel,
      });
    case "reconnecting":
      return translate(
        "common:mobileConnections.reconnecting",
        "Reconnecting to {{environment}}…",
        { environment: environmentLabel },
      );
    case "unsupported":
      return translate("common:mobileConnections.clientNotSupported", "Client not supported");
    case "error":
      return translate(
        "common:mobileConnections.environmentUnavailable",
        "{{environment}} is unavailable",
        { environment: environmentLabel },
      );
    case "available":
      return translate(
        "common:mobileConnections.environmentDisconnected",
        "{{environment}} is disconnected",
        { environment: environmentLabel },
      );
    case "connected":
      return "";
  }
}

function noticeDetail(
  phase: EnvironmentConnectionPhase,
  resourceName: string,
  error: string | null,
): string {
  if (error) {
    return phase === "reconnecting"
      ? translate(
          "common:mobileConnections.retryingAutomatically",
          "The app will keep retrying automatically. {{error}}",
          { error },
        )
      : error;
  }

  switch (phase) {
    case "offline":
      return translate(
        "common:mobileConnections.cachedDataAvailable",
        "Cached data remains available. The {{resource}} will load when your connection returns.",
        { resource: resourceName },
      );
    case "connecting":
    case "reconnecting":
      return translate(
        "common:mobileConnections.resourceLoadsWhenReady",
        "The {{resource}} will load as soon as the environment is ready.",
        { resource: resourceName },
      );
    case "unsupported":
      return translate(
        "common:mobileConnections.compatibleVersions",
        "Use compatible versions of the app and server to connect.",
      );
    case "available":
    case "error":
      return translate(
        "common:mobileConnections.reconnectForResource",
        "Reconnect the environment to load the {{resource}}.",
        { resource: resourceName },
      );
    case "connected":
      return "";
  }
}

export function EnvironmentConnectionNotice(props: {
  readonly environmentLabel: string;
  readonly connection: EnvironmentConnectionPresentation;
  readonly resourceName: string;
  readonly onRetry: () => void;
}) {
  const { t } = useTranslation();
  const isRetrying =
    props.connection.phase === "connecting" || props.connection.phase === "reconnecting";

  return (
    <View className="flex-1 items-center justify-center px-8">
      <View className="max-w-[320px] items-center gap-3">
        {isRetrying ? (
          <ActivityIndicator size="small" colorClassName={"accent-icon-muted"} />
        ) : (
          <SymbolView
            name={props.connection.phase === "offline" ? "wifi.slash" : "bolt.horizontal.circle"}
            size={24}
            tintColorClassName={"accent-icon-muted"}
            type="monochrome"
          />
        )}

        <Text className="text-center text-lg font-t3-bold text-foreground">
          {noticeTitle(props.connection.phase, props.environmentLabel)}
        </Text>
        <Text className="text-center text-sm leading-normal text-foreground-muted">
          {noticeDetail(props.connection.phase, props.resourceName, props.connection.error)}
          {props.connection.traceId ? (
            <ConnectionTraceId traceId={props.connection.traceId} />
          ) : null}
        </Text>

        {props.connection.phase !== "offline" && props.connection.phase !== "unsupported" ? (
          <Pressable
            accessibilityRole="button"
            className="mt-1 rounded-full bg-subtle px-4 py-2.5 active:opacity-70"
            onPress={props.onRetry}
          >
            <Text className="text-sm font-t3-bold text-foreground">{t("retryNow")}</Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}
