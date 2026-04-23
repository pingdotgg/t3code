export type ProjectFileEditorStatus =
  | "idle"
  | "loading"
  | "ready"
  | "saving"
  | "conflict"
  | "unsupported"
  | "missing"
  | "error";

export function normalizeProjectFileEditError(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  return "An unexpected error occurred.";
}

export function resolveProjectFileEditorError(error: unknown): {
  status: Extract<ProjectFileEditorStatus, "missing" | "unsupported" | "error" | "conflict">;
  message: string;
} {
  const tagged = error as { _tag?: string };
  const message = normalizeProjectFileEditError(error);

  if (tagged?._tag === "ProjectFileVersionConflictError") {
    return {
      status: "conflict",
      message,
    };
  }

  if (tagged?._tag === "ProjectFileNotFoundError") {
    return {
      status: "missing",
      message,
    };
  }

  if (tagged?._tag === "ProjectFileBinaryError" || tagged?._tag === "ProjectFileTooLargeError") {
    return {
      status: "unsupported",
      message,
    };
  }

  return {
    status: "error",
    message,
  };
}
