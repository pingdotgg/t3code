import { msg, useGT, useMessages } from "gt-react-native";
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
import type { MessageResolver } from "../../i18n/messages";

function noticeTitle(
  phase: EnvironmentConnectionPhase,
  environmentLabel: string,
  awaitingApproval: boolean,
  resolve: MessageResolver,
): string {
  const environment = environmentLabel;
  if (awaitingApproval)
    return resolve(msg("Waiting for {environment} to approve this device", { environment }));
  switch (phase) {
    case "offline":
      return resolve(msg("You are offline"));
    case "connecting":
      return resolve(msg("Connecting to {environment}...", { environment }));
    case "reconnecting":
      return resolve(msg("Reconnecting to {environment}...", { environment }));
    case "unsupported":
      return resolve(msg("Client not supported"));
    case "error":
      return resolve(msg("{environment} is unavailable", { environment }));
    case "available":
      return resolve(msg("{environment} is disconnected", { environment }));
    case "connected":
      return "";
  }
}

function noticeDetail(
  phase: EnvironmentConnectionPhase,
  resourceName: string,
  error: string | null,
  awaitingApproval: boolean,
  resolve: MessageResolver,
): string {
  if (error && awaitingApproval) return error;
  if (error) {
    return phase === "reconnecting"
      ? resolve(msg("The app will keep retrying automatically. {error}", { error }))
      : error;
  }

  const resource = resourceName;
  switch (phase) {
    case "offline":
      return resolve(
        msg(
          "Cached data remains available. The {resource} will load when your connection returns.",
          { resource },
        ),
      );
    case "connecting":
    case "reconnecting":
      return resolve(
        msg("The {resource} will load as soon as the environment is ready.", { resource }),
      );
    case "unsupported":
      return resolve(msg("Use compatible versions of the app and server to connect."));
    case "available":
    case "error":
      return resolve(msg("Reconnect the environment to load the {resource}.", { resource }));
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
  const gt = useGT();
  const m = useMessages();
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
          {noticeTitle(
            props.connection.phase,
            props.environmentLabel,
            props.connection.awaitingApproval === true,
            m,
          )}
        </Text>
        <Text className="text-center text-sm leading-normal text-foreground-muted">
          {noticeDetail(
            props.connection.phase,
            props.resourceName,
            props.connection.error,
            props.connection.awaitingApproval === true,
            m,
          )}
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
