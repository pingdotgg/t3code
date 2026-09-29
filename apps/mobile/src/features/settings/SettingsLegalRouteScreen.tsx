import { translate } from "@t3tools/i18n";
import { SettingsLegalDocumentRouteScreen } from "./components/SettingsLegalDocumentRouteScreen";
import { LEGAL_URL } from "./lib/legal-document-url";

export function SettingsLegalRouteScreen() {
  return (
    <SettingsLegalDocumentRouteScreen
      documentName={translate("settings:legal", "Legal")}
      documentUrl={LEGAL_URL}
    />
  );
}
