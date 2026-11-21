import { useGT } from "gt-react-native";
import { defineNativePluginFeature } from "../../plugins/features";
import { SettingsLegalDocumentRouteScreen } from "./components/SettingsLegalDocumentRouteScreen";
import { LEGAL_URL } from "./lib/legal-document-url";

function BuiltinSettingsLegalRouteScreen() {
  const gt = useGT();
  return (
    <SettingsLegalDocumentRouteScreen
      documentName={gt("Legal", { $context: "legal documents page title" })}
      documentUrl={LEGAL_URL}
    />
  );
}

export const SettingsLegalRouteScreen = defineNativePluginFeature(
  "settings.legal",
  BuiltinSettingsLegalRouteScreen,
);
