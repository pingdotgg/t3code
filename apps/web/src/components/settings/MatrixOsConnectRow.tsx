import { ExternalLinkIcon } from "lucide-react";
import { useState } from "react";
import {
  MATRIX_OS_SETUP_ACTION_LABEL,
  MATRIX_OS_SETUP_DESCRIPTION,
} from "@t3tools/shared/matrixOsConnect";

import { readLocalApi } from "../../localApi";
import { Button } from "../ui/button";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { openMatrixOsConnect } from "./openMatrixOsConnect";
import { SettingsRow } from "./settingsLayout";

export function MatrixOsConnectRow() {
  const [isOpening, setIsOpening] = useState(false);

  const handleConnect = async () => {
    const api = readLocalApi();
    if (!api) {
      toastManager.add({ type: "error", title: "Link opening is unavailable." });
      return;
    }

    setIsOpening(true);
    try {
      await openMatrixOsConnect(api.shell);
    } catch (error) {
      console.error("Failed to open the Matrix OS setup link.", error);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Unable to open Matrix OS",
          description: "Open app.matrix-os.com and connect T3 Code from its Terminal.",
        }),
      );
    } finally {
      setIsOpening(false);
    }
  };

  return (
    <SettingsRow
      title="Matrix OS"
      description={MATRIX_OS_SETUP_DESCRIPTION}
      control={
        <Button
          size="sm"
          variant="outline"
          disabled={isOpening}
          onClick={() => void handleConnect()}
        >
          <ExternalLinkIcon aria-hidden className="size-3.5" />
          {isOpening ? "Opening…" : MATRIX_OS_SETUP_ACTION_LABEL}
        </Button>
      }
    />
  );
}
