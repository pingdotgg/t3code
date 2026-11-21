import { CANVAS_UPLOAD_MAX_BYTES, type ProjectId, type ScopedThreadRef } from "@t3tools/contracts";
import {
  CANVAS_IMPORT_ACCEPT,
  unsupportedCanvasFileMessage,
} from "@t3tools/shared/canvasImportFormats";
import { useGT } from "gt-react";
import { useRef, useState } from "react";
import { useAtomValue } from "@effect/atom-react";

import { toastManager } from "~/components/ui/toast";
import { useRightPanelStore } from "~/rightPanelStore";
import { canvasEnvironment } from "~/state/canvas";
import { formatEnvironmentQueryError } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";

import { refreshCanvasList } from "./canvasRpc";

/** The first dropped or picked file a canvas can import. */
export function canvasImportFile(files: FileList | null): File | null {
  return (
    [...(files ?? [])].find((file) => unsupportedCanvasFileMessage(file.name) === null) ??
    files?.[0] ??
    null
  );
}

/** Creating and importing canvases for a thread's project; results open as tabs. */
export function useCanvasImport(threadRef: ScopedThreadRef, projectId: ProjectId | null) {
  const create = useAtomCommand(canvasEnvironment.create, { reportFailure: false });
  const upload = useAtomCommand(canvasEnvironment.importFile, { reportFailure: false });
  const canCreate = useAtomValue(canvasEnvironment.create.permissionAtom(threadRef.environmentId));
  const [importing, setImporting] = useState(false);
  const importPending = useRef(false);
  const gt = useGT();

  // Plain functions: the React Compiler memoizes them.
  const run = async (file?: File) => {
    if (!projectId || !canCreate) return;
    const result = file
      ? await upload({
          environmentId: threadRef.environmentId,
          input: {
            metadata: {
              projectId,
              fileName: file.name,
              name: file.name.replace(/\.[^.]+$/, ""),
            },
            ...(await prepareCanvasUpload(file)),
          },
        })
      : await create({
          environmentId: threadRef.environmentId,
          input: { projectId, name: "Untitled" },
        });
    if (result._tag === "Success") {
      refreshCanvasList(threadRef.environmentId, projectId);
      useRightPanelStore.getState().openCanvas(threadRef, result.value.id, result.value.name);
      const { warnings } = result.value;
      if (file && warnings.length > 0) {
        toastManager.add({
          type: "warning",
          title: gt(
            "{count, plural, one {Imported {name} with {count} warning} other {Imported {name} with {count} warnings}}",
            { count: warnings.length, name: file.name },
          ),
          description: warnings.slice(0, 3).join("\n"),
        });
      }
      return;
    }
    toastManager.add({
      type: "error",
      title: file
        ? gt("Unable to import {name}", { name: file.name })
        : gt("Unable to create canvas"),
      description: formatEnvironmentQueryError(result.cause),
    });
  };

  const importFile = async (file: File) => {
    if (importPending.current || !projectId || !canCreate) return;
    const unsupported = unsupportedCanvasFileMessage(file.name);
    if (unsupported) {
      toastManager.add({
        type: "error",
        title: gt("Unable to import {name}", { name: file.name }),
        description: unsupported,
      });
      return;
    }
    if (file.size > CANVAS_UPLOAD_MAX_BYTES) {
      toastManager.add({
        type: "error",
        title: gt("Unable to import {name}", { name: file.name }),
        description: gt(
          "Browser imports are limited to {size} MiB. Ask an agent to import larger files from the workspace.",
          { size: CANVAS_UPLOAD_MAX_BYTES / (1024 * 1024) },
        ),
      });
      return;
    }
    importPending.current = true;
    setImporting(true);
    await run(file)
      .catch((error: unknown) => {
        toastManager.add({
          type: "error",
          title: gt("Unable to import {name}", { name: file.name }),
          description: error instanceof Error ? error.message : gt("The file could not be read."),
        });
      })
      .finally(() => {
        importPending.current = false;
        setImporting(false);
      });
  };

  const pickFile = () => {
    if (!canCreate || !projectId || importPending.current) return;
    const input = document.createElement("input");
    input.type = "file";
    input.accept = CANVAS_IMPORT_ACCEPT;
    input.addEventListener("change", () => {
      const file = canvasImportFile(input.files);
      if (file) void importFile(file);
    });
    input.click();
  };

  const createBlank = () => run();

  return {
    importing,
    importFile,
    pickFile,
    createBlank,
    available: projectId !== null && canCreate,
  };
}

export type CanvasImporter = ReturnType<typeof useCanvasImport>;

/** Stored zip snapshots often contain huge JSON files; compress before crossing the network. */
async function prepareCanvasUpload(file: File) {
  if (file.size >= 1024 * 1024 && typeof CompressionStream !== "undefined") {
    const compressed = new Uint8Array(
      await new Response(file.stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer(),
    );
    if (compressed.byteLength < file.size * 0.95) {
      return { bytes: compressed, encoding: "gzip" as const };
    }
  }
  return { bytes: new Uint8Array(await file.arrayBuffer()) };
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
}
