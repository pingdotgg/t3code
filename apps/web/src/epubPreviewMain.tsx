import { epubPreviewRequest } from "@t3tools/shared/filePreview";
import { T } from "gt-react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/inter";
import "./index.css";
import OfficeViewer from "./components/files/OfficeViewer";
import { SharedTooltipProvider } from "./components/ui/shared-tooltip";
import { I18nProvider } from "./i18n/I18nProvider";
import { startI18n, whenLocaleReady } from "./i18n/runtime";
import { refreshTheme } from "./hooks/useTheme";

const request = epubPreviewRequest(new URL(location.href));
const root = document.getElementById("t3-epub-preview");
if (root) {
  refreshTheme();
  startI18n();
  void whenLocaleReady().then(() =>
    createRoot(root).render(
      <I18nProvider>
        <SharedTooltipProvider>
          {request ? (
            <OfficeViewer {...request} kind="epub" />
          ) : (
            <p className="p-4 text-body">
              <T>The file is unavailable.</T>
            </p>
          )}
        </SharedTooltipProvider>
      </I18nProvider>,
    ),
  );
}
