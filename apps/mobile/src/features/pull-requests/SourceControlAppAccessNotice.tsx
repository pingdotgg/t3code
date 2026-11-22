import { EnvironmentId } from "@t3tools/contracts";
import {
  readHostCredentialSettings,
  sourceControlClients,
} from "@t3tools/client-runtime/source-control-clients";
import { T, Var } from "gt-react-native";
import { Pressable, View } from "react-native";
import { tryOpenExternalUrl } from "../../lib/openExternalUrl";

import { AppText as Text } from "../../components/ui/AppText";
import { useEnvironmentPresentation } from "../../state/presentation";
import { useEnvironmentQuery } from "../../state/query";
import { sourceControlEnvironment } from "../../state/sourceControl";

/**
 * Says when the server's forge app sign-in cannot reach `repository`, so requests there fall back
 * to the user's own login. Renders nothing for servers that do not use the app.
 */
export function SourceControlAppAccessNotice(props: {
  readonly environmentId: string;
  readonly provider: string | undefined;
  readonly host: string | undefined;
  /** `owner/name`. */
  readonly repository: string;
}) {
  const environmentId = EnvironmentId.make(props.environmentId);
  const { presentation } = useEnvironmentPresentation(environmentId);
  const definition = props.provider ? sourceControlClients.find(props.provider) : undefined;
  const appSignIn = definition?.credentials?.appSignIn;
  const host = (props.host ?? definition?.publicHost ?? "").toLowerCase();
  const settings = presentation?.serverConfig?.settings;
  const signedIn =
    definition !== undefined &&
    settings !== undefined &&
    (readHostCredentialSettings(settings, definition.kind).signIns[host] ?? "").length > 0;
  const access = useEnvironmentQuery(
    definition !== undefined && appSignIn?.hosts.includes(host) && signedIn
      ? sourceControlEnvironment.appAccess({
          environmentId,
          input: { provider: definition.kind, host, repository: props.repository },
        })
      : null,
  );
  if (appSignIn === undefined || access.data?.status !== "not-covered") return null;
  const owner = props.repository.split("/")[0] ?? props.repository;

  return (
    <View className="mb-4 gap-1 rounded-2xl bg-grouped-card px-4 py-3">
      <Text className="text-sm text-foreground-muted">
        <T>
          <Var>{appSignIn.appName}</Var> isn't installed on <Var>{owner}</Var>, so requests here use
          your own GitHub login and its lower rate limit.
        </T>
      </Text>
      <Pressable
        accessibilityRole="link"
        onPress={() => void tryOpenExternalUrl(appSignIn.installUrl, "provider-auth")}
      >
        <Text className="text-sm font-t3-bold text-foreground">
          <T>
            Install on <Var>{owner}</Var>
          </T>
        </Text>
      </Pressable>
    </View>
  );
}
