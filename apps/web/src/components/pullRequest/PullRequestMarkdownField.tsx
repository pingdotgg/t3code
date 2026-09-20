import {
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  type EnvironmentId,
  type PullRequestDetailView,
  type PullRequestRef,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { parseChangeRequestUrl } from "@t3tools/shared/changeRequestUrl";
import { formatAttachmentSize } from "@t3tools/client-runtime/state/attachments";
import { PaperclipIcon, XIcon } from "lucide-react";
import {
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import {
  awaitAttachmentUploads,
  readAttachmentUpload,
  releaseAttachmentUpload,
  startAttachmentUpload,
} from "~/lib/attachmentUploadQueue";
import { pullRequestEnvironment } from "~/state/pullRequests";
import { formatEnvironmentQueryError } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";

import { useOpenLink } from "~/browser/useOpenLink";

import { randomUUID } from "~/lib/utils";

import { Button } from "../ui/button";
import { Textarea, type TextareaProps } from "../ui/textarea";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { PullRequestMarkdown } from "./PullRequestMarkdown";
import { PullRequestAttachmentContext } from "./PullRequestAttachmentContext";

export function PullRequestAttachmentProvider({
  environmentId,
  reference: requestedReference,
  capabilities,
  provider,
  cwd,
  url,
  children,
}: {
  environmentId: EnvironmentId;
  reference: PullRequestRef;
  capabilities: PullRequestDetailView["capabilities"]["attachments"];
  provider?: PullRequestDetailView["provider"] | undefined;
  cwd: string;
  url: string | undefined;
  children: ReactNode;
}) {
  const reference = useMemo(() => {
    const host = requestedReference.host ?? (url ? parseChangeRequestUrl(url)?.host : undefined);
    return host ? { ...requestedReference, host } : requestedReference;
  }, [requestedReference, url]);
  const upload = useAtomCommand(pullRequestEnvironment.uploadAttachment, { reportFailure: false });
  const value = useMemo(
    () => ({
      environmentId,
      reference,
      cwd,
      url,
      capabilities,
      provider,
      upload: async (attachmentId: string, file: File) => {
        const result = await upload({
          environmentId,
          input: {
            ...reference,
            attachmentId,
            name: file.name,
            mimeType: file.type || "application/octet-stream",
          },
        });
        if (result._tag === "Failure") throw new Error(formatEnvironmentQueryError(result.cause));
        return result.value.markdown;
      },
    }),
    [environmentId, reference, cwd, url, capabilities, provider, upload],
  );
  const scope = JSON.stringify([
    environmentId,
    reference.projectId,
    reference.host,
    reference.repository,
    reference.number,
    reference.expectedAccountId,
  ]);
  return (
    <PullRequestAttachmentContext key={scope} value={value}>
      {children}
    </PullRequestAttachmentContext>
  );
}

type Upload = { id: string; file: File; error: string | null };

export function PullRequestMarkdownField({
  value,
  onChange,
  onUploadPendingChange,
  environmentId,
  cwd,
  threadRef = null,
  textareaRef,
  ...props
}: Omit<TextareaProps, "value" | "onChange" | "ref"> & {
  value: string;
  onChange: (value: string) => void;
  onUploadPendingChange: (pending: boolean) => void;
  environmentId: EnvironmentId;
  cwd?: string;
  threadRef?: ScopedThreadRef | null;
  textareaRef?: (element: HTMLTextAreaElement | null) => void;
}) {
  const context = useContext(PullRequestAttachmentContext);
  const openLink = useOpenLink(threadRef);
  const inputRef = useRef<HTMLInputElement>(null);
  const textRef = useRef<HTMLTextAreaElement | null>(null);
  const current = useRef({ value, onChange, onUploadPendingChange });
  useLayoutEffect(() => {
    current.current = { value, onChange, onUploadPendingChange };
  }, [value, onChange, onUploadPendingChange]);
  const active = useRef(new Map<string, Upload>());
  const alive = useRef(true);
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [preview, setPreview] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const supported = context?.capabilities?.supported === true;
  const maxBytes = Math.min(
    context?.capabilities?.maxBytes ?? 0,
    PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  );

  useEffect(() => {
    alive.current = true;
    const pending = active.current;
    return () => {
      alive.current = false;
      for (const id of pending.keys()) releaseAttachmentUpload(id);
      pending.clear();
      current.current.onUploadPendingChange(false);
    };
  }, []);

  const updateUploads = () => {
    setUploads([...active.current.values()]);
    current.current.onUploadPendingChange(active.current.size > 0);
  };

  const insert = (markdown: string) => {
    const textarea = textRef.current;
    const draft = current.current.value;
    const start = textarea?.selectionStart ?? draft.length;
    const insertion = `${start > 0 && draft[start - 1] !== "\n" ? "\n" : ""}${markdown}\n`;
    const next = draft.slice(0, start) + insertion + draft.slice(start);
    const focused = document.activeElement === textarea;
    current.current.value = next;
    current.current.onChange(next);
    requestAnimationFrame(() => {
      if (
        focused &&
        textarea === textRef.current &&
        document.activeElement === textarea &&
        textarea?.value === next
      )
        textarea?.setSelectionRange(start + insertion.length, start + insertion.length);
    });
  };

  const upload = async (item: Upload) => {
    if (!context) return;
    active.current.set(item.id, { ...item, error: null });
    updateUploads();
    try {
      startAttachmentUpload({
        environmentId: context.environmentId,
        image: {
          type: "file",
          id: item.id,
          name: item.file.name,
          mimeType: item.file.type || "application/octet-stream",
          sizeBytes: item.file.size,
          file: item.file,
        },
      });
      await awaitAttachmentUploads([item.id]);
      if (!alive.current || !active.current.has(item.id)) return;
      const result = readAttachmentUpload(item.id);
      if (result?.status !== "ready")
        throw new Error(result?.status === "failed" ? result.reason : "Upload did not finish.");
      const markdown = await context.upload(result.attachmentId, item.file);
      if (!alive.current || !active.current.has(item.id)) return;
      insert(markdown);
      active.current.delete(item.id);
    } catch (cause) {
      if (!alive.current || !active.current.has(item.id)) return;
      active.current.set(item.id, {
        ...item,
        error: cause instanceof Error ? cause.message : "Upload failed. Try again.",
      });
    } finally {
      releaseAttachmentUpload(item.id);
      if (alive.current) updateUploads();
    }
  };

  const attach = (files: FileList | File[]) => {
    if (props.disabled) return;
    if (!supported) {
      setError(
        context?.capabilities?.reason ??
          "Attachments are not available on this server. Update T3 Code or attach the file on the source host.",
      );
      return;
    }
    setError(null);
    for (const file of Array.from(files)) {
      const extensions = context?.capabilities?.acceptedExtensions;
      if (
        extensions &&
        !extensions.some((extension) => file.name.toLowerCase().endsWith(extension))
      ) {
        setError(`${file.name}: this host accepts ${extensions.join(", ")}.`);
        continue;
      }
      if (file.size === 0 || file.size > maxBytes) {
        setError(`${file.name}: choose a non-empty file up to ${formatAttachmentSize(maxBytes)}.`);
        continue;
      }
      void upload({ id: randomUUID(), file, error: null });
    }
  };

  return (
    <div
      className="space-y-2"
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes("Files") && !props.disabled) event.preventDefault();
      }}
      onDrop={(event) => {
        if (event.dataTransfer.files.length === 0) return;
        event.preventDefault();
        event.stopPropagation();
        attach(event.dataTransfer.files);
      }}
    >
      <ToggleGroup
        aria-label="Markdown editor mode"
        variant="segmented"
        value={[preview ? "preview" : "write"]}
        disabled={props.disabled}
        onValueChange={(next) => {
          if (next[0] === "write" || next[0] === "preview") setPreview(next[0] === "preview");
        }}
      >
        <Toggle value="write">Write</Toggle>
        <Toggle value="preview">Preview</Toggle>
      </ToggleGroup>
      {preview ? (
        <div className="rounded-lg border border-border/60 px-3 py-2">
          {value.trim() ? (
            <PullRequestMarkdown
              text={value}
              cwd={cwd ?? context?.cwd ?? ""}
              environmentId={environmentId}
              threadRef={threadRef}
            />
          ) : (
            <p className="text-xs text-muted-foreground">Nothing to preview.</p>
          )}
        </div>
      ) : (
        <Textarea
          {...props}
          ref={(element) => {
            textRef.current = element;
            textareaRef?.(element);
          }}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onPaste={(event) => {
            props.onPaste?.(event);
            if (event.defaultPrevented || !event.clipboardData.files.length) return;
            event.preventDefault();
            attach(event.clipboardData.files);
          }}
        />
      )}
      {context ? (
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <input
            ref={inputRef}
            type="file"
            accept={context.capabilities?.acceptedExtensions?.join(",")}
            multiple
            hidden
            onChange={(event) => {
              if (event.target.files) attach(event.target.files);
              event.target.value = "";
            }}
          />
          <Button
            size="xs"
            variant="ghost"
            disabled={props.disabled}
            title={context.capabilities?.reason}
            onClick={() => (supported ? inputRef.current?.click() : attach([]))}
          >
            <PaperclipIcon className="size-3.5" />
            Attach files
          </Button>
          <span>
            {context.capabilities?.destination === "repository-downloads"
              ? "Files upload to repository Downloads."
              : "Drop files or paste images."}
          </span>
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
      {(error || uploads.some((item) => item.error)) && context?.url ? (
        <Button
          size="xs"
          variant="link"
          onClick={() => {
            void openLink(context.url!);
          }}
        >
          Open on source host
        </Button>
      ) : null}
      {uploads.map((item) => (
        <div
          key={item.id}
          className="flex items-center gap-2 text-xs"
          role={item.error ? "alert" : "status"}
        >
          <span className="min-w-0 flex-1 break-words">
            {item.error ? `${item.file.name}: ${item.error}` : `Uploading ${item.file.name}…`}
          </span>
          {item.error ? (
            <Button
              size="xs"
              variant="ghost"
              disabled={props.disabled}
              onClick={() => void upload(item)}
            >
              Retry
            </Button>
          ) : null}
          <Button
            size="icon-xs"
            variant="ghost"
            disabled={props.disabled}
            aria-label={`Remove ${item.file.name}`}
            onClick={() => {
              active.current.delete(item.id);
              releaseAttachmentUpload(item.id);
              updateUploads();
            }}
          >
            <XIcon className="size-3.5" />
          </Button>
        </div>
      ))}
    </div>
  );
}
