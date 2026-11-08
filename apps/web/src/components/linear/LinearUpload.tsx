import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import * as Cause from "effect/Cause";
import { useState } from "react";
import { linearEnvironment } from "../../state/linear";
import { useAtomCommand } from "../../state/use-atom-command";
import { Input } from "../ui/input";

function readBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("The file could not be read."));
    reader.onload = () =>
      typeof reader.result === "string"
        ? resolve(reader.result.slice(reader.result.indexOf(",") + 1))
        : reject(new Error("The file could not be read."));
    reader.readAsDataURL(file);
  });
}
export function LinearUpload({
  environmentId,
  disabled,
  onUploaded,
  onPendingChange,
}: {
  environmentId: EnvironmentId;
  disabled?: boolean;
  onUploaded: (file: { url: string; name: string; contentType: string }) => void | Promise<void>;
  onPendingChange?: (pending: boolean) => void;
}) {
  const upload = useAtomCommand(linearEnvironment.upload, { reportFailure: false });
  const allowed = useAtomValue(linearEnvironment.upload.permissionAtom(environmentId));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const send = async (file: File) => {
    setError(null);
    if (file.size > 8 * 1024 * 1024) {
      setError("Choose a file smaller than 8 MB.");
      return;
    }
    setPending(true);
    onPendingChange?.(true);
    try {
      const result = await upload({
        environmentId,
        input: {
          filename: file.name,
          contentType: file.type || "application/octet-stream",
          base64: await readBase64(file),
        },
      });
      if (AsyncResult.isFailure(result)) {
        setError(String(Cause.squash(result.cause)));
      } else {
        await onUploaded({ url: result.value.assetUrl, name: file.name, contentType: file.type });
      }
    } catch {
      setError("The file could not be uploaded. Try again.");
    }
    setPending(false);
    onPendingChange?.(false);
  };
  return (
    <div className="flex flex-col gap-1">
      <label className="flex flex-col gap-1 text-xs text-muted-foreground">
        {pending ? "Uploading…" : "Attach a file · private storage · up to 8 MB"}
        <Input
          aria-label="Upload a file to Linear"
          type="file"
          disabled={!allowed || disabled || pending}
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void send(file);
            event.target.value = "";
          }}
        />
      </label>
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
export function linearFileMarkdown(file: { url: string; name: string; contentType: string }) {
  const label = file.name.replace(/[[\]\\]/g, "_");
  return `${file.contentType.startsWith("image/") ? "!" : ""}[${label}](${file.url})`;
}
