import * as Application from "expo-application";
import Constants from "expo-constants";
import { Directory, File, FileMode, Paths } from "expo-file-system";
import * as Sharing from "expo-sharing";
import * as Updates from "expo-updates";
import { Platform } from "react-native";

import { createDiagnosticLog, type DiagnosticAppIdentity } from "./diagnostic-log";

export function diagnosticAppIdentity(): DiagnosticAppIdentity {
  return {
    version: Application.nativeApplicationVersion ?? Constants.expoConfig?.version ?? "dev",
    build: Application.nativeBuildVersion ?? "dev",
    updateId: Updates.updateId,
    runtimeVersion: Updates.runtimeVersion,
    platform: Platform.OS,
    osVersion: String(Platform.Version),
  };
}

function files() {
  const directory = new Directory(Paths.document, "diagnostics");
  return {
    directory,
    current: new File(directory, "current.jsonl"),
    previous: new File(directory, "previous.jsonl"),
  };
}

export const savedDiagnostics = createDiagnosticLog(
  {
    size: () => files().current.size ?? 0,
    append(bytes) {
      const { directory, current } = files();
      directory.create({ intermediates: true, idempotent: true });
      if (!current.exists) current.create();
      const handle = current.open(FileMode.ReadWrite);
      try {
        handle.offset = handle.size ?? 0;
        handle.writeBytesSync(bytes);
      } finally {
        handle.close();
      }
    },
    rotate() {
      const { current, previous } = files();
      if (previous.exists) previous.delete();
      if (current.exists) current.moveSync(previous);
    },
    read() {
      const { previous, current } = files();
      return [previous, current].map((file) => (file.exists ? file.textSync() : "")).join("\n");
    },
    clear() {
      const { previous, current } = files();
      for (const file of [previous, current, new File(Paths.cache, "t3-code-diagnostics.txt")]) {
        if (file.exists) file.delete();
      }
    },
  },
  Constants.sessionId,
  () => new Date().toISOString(),
);

export async function shareSavedDiagnostics() {
  if (!(await Sharing.isAvailableAsync()))
    throw new Error("Sharing is unavailable on this device.");
  const file = new File(Paths.cache, "t3-code-diagnostics.txt");
  try {
    await file.write(savedDiagnostics.report(diagnosticAppIdentity()));
    await Sharing.shareAsync(file.uri, {
      mimeType: "text/plain",
      UTI: "public.plain-text",
      dialogTitle: "Share diagnostics",
    });
  } finally {
    if (file.exists) file.delete();
  }
}
