import { msg, useGT } from "gt-react-native";
import { Button } from "../../components/ui/Button";
import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { ConnectionTraceId } from "./ConnectionTraceId";
import {
  type EnvironmentConnectionPhase,
  type EnvironmentConnectionPresentation,
} from "@t3tools/client-runtime/connection";
import { SymbolView } from "../../components/ui/AppSymbol";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { m, type MessageResolver } from "../../i18n/messages";

function noticeTitle(
  connection: EnvironmentConnectionPresentation,
  environmentLabel: string,
  resolve: MessageResolver = m,
): string {
  const environment = environmentLabel;
  switch (connection.phase) {
    case "offline":
      return `${environmentLabel} is offline`;
    case "connecting":
      return resolve(msg("Connecting to {environment}...", { environment }));
    case "reconnecting":
      return resolve(msg("Reconnecting to {environment}...", { environment }));
    case "unsupported":
      return resolve(msg("Client not supported"));
    case "error":
      return connection.needsPairing === true
        ? `${environmentLabel} needs pairing again`
        : `${environmentLabel} is unavailable`;
    case "available":
      return resolve(msg("{environment} is disconnected", { environment }));
    case "connected":
      return "";
  }
}

type ConnectionNoticeResource = "preview" | "review" | "terminal";

const OFFLINE_DETAIL = {
  preview: msg(
    "Cached data remains available. The preview will load when your connection returns.",
  ),
  review: msg("Cached data remains available. The review will load when your connection returns."),
  terminal: msg(
    "Cached data remains available. The terminal will load when your connection returns.",
  ),
} satisfies Record<ConnectionNoticeResource, string>;

const CONNECTING_DETAIL = {
  preview: msg("The preview will load as soon as the environment is ready."),
  review: msg("The review will load as soon as the environment is ready."),
  terminal: msg("The terminal will load as soon as the environment is ready."),
} satisfies Record<ConnectionNoticeResource, string>;

const RECONNECT_DETAIL = {
  preview: msg("Reconnect the environment to load the preview."),
  review: msg("Reconnect the environment to load the review."),
  terminal: msg("Reconnect the environment to load the terminal."),
} satisfies Record<ConnectionNoticeResource, string>;

function noticeDetail(
  phase: EnvironmentConnectionPhase,
  resource: ConnectionNoticeResource,
  error: string | null,
  resolve: MessageResolver = m,
): string {
  if (error) {
    return phase === "reconnecting"
      ? resolve(msg("The app will keep retrying automatically. {error}", { error }))
      : error;
  }

  switch (phase) {
    case "offline":
      return resolve(OFFLINE_DETAIL[resource]);
    case "connecting":
    case "reconnecting":
      return resolve(CONNECTING_DETAIL[resource]);
    case "unsupported":
      return resolve(msg("Use compatible versions of the app and server to connect."));
    case "available":
    case "error":
      return resolve(RECONNECT_DETAIL[resource]);
    case "connected":
      return "";
  }
}

export function EnvironmentConnectionNotice(props: {
  readonly environmentLabel: string;
  readonly connection: EnvironmentConnectionPresentation;
  readonly resource: ConnectionNoticeResource;
  readonly onRetry: () => void;
}) {
  const gt = useGT();
  const isRetrying =
    props.connection.phase === "connecting" || props.connection.phase === "reconnecting";

  return (
    <View className="flex-1 items-center justify-center px-8">
      <View className="max-w-[320px] items-center gap-3">
        {isRetrying ? (
          <AppActivityIndicator size="small" colorClassName={"accent-icon-muted"} />
        ) : (
          <SymbolView
            name={props.connection.phase === "offline" ? "wifi.slash" : "bolt.horizontal.circle"}
            size={24}
            tintColorClassName={"accent-icon-muted"}
            type="monochrome"
          />
        )}

        <Text className="text-center text-lg font-t3-bold text-foreground">
          {noticeTitle(props.connection, props.environmentLabel)}
        </Text>
        <Text className="text-center text-sm leading-normal text-foreground-muted">
          {noticeDetail(props.connection.phase, props.resource, props.connection.error)}
          {props.connection.traceId ? (
            <ConnectionTraceId traceId={props.connection.traceId} />
          ) : null}
        </Text>

        {props.connection.phase !== "offline" && props.connection.phase !== "unsupported" ? (
          <View className="mt-1">
            <Button label={gt("Retry now")} tone="secondary" onPress={props.onRetry} />
          </View>
        ) : null}
      </View>
    </View>
  );
}
