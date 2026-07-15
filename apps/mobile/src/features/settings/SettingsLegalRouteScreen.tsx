import { SettingsLegalDocumentRouteScreen } from "./components/SettingsLegalDocumentRouteScreen";
import {
  LEGAL_URL,
  PRIVACY_POLICY_URL,
  SECURITY_POLICY_URL,
  TERMS_OF_SERVICE_URL,
} from "./lib/legal-document-url";

const ALLOWED_LEGAL_DOCUMENT_URLS = [
  LEGAL_URL,
  PRIVACY_POLICY_URL,
  TERMS_OF_SERVICE_URL,
  SECURITY_POLICY_URL,
] as const;

export function SettingsLegalRouteScreen() {
  return (
    <SettingsLegalDocumentRouteScreen
      allowedDocumentUrls={ALLOWED_LEGAL_DOCUMENT_URLS}
      documentName="Legal"
      documentUrl={LEGAL_URL}
    />
  );
}
