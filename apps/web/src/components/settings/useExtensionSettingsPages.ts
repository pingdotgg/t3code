import { extensionSettingsPages } from "@t3tools/client-runtime/state/extensions";
import { extensionEnvironment } from "../../state/extensions";
import { useEnvironmentQuery } from "../../state/query";
import { useOptionalSettingsScope } from "./SettingsScopeContext";

export const extensionSettingsPath = (id: string, pageId: string) =>
  `/settings/extension/${encodeURIComponent(id)}/${encodeURIComponent(pageId)}`;

export function useExtensionSettingsPages() {
  const environment = useOptionalSettingsScope()?.environment;
  const environmentId = environment?.environmentId;
  const query = useEnvironmentQuery(
    environmentId && environment?.serverConfig?.environment.capabilities.extensions
      ? extensionEnvironment.state({ environmentId, input: {} })
      : null,
  );
  return { environmentId, pages: extensionSettingsPages(query.data ?? []) };
}
