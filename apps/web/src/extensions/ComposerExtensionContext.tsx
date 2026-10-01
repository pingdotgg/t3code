import { useMemo, useState } from "react";
import {
  appendContextSnapshot,
  readContextSnapshots,
  removeContextSnapshot,
} from "@t3tools/extension-sdk/context";
import type { ViewContext } from "@t3tools/extension-sdk/contracts";
import { Button } from "~/components/ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "~/components/ui/menu";
import { captureWorkspaceContext, useWorkspaceContextDescriptors } from "./workspaceRegistry";

/** Selected context is readable prompt text, so existing draft persistence and recovery own it. */
export function ComposerExtensionContext(props: {
  readonly prompt: string;
  readonly context: ViewContext;
  readonly onChange: (prompt: string) => void;
}) {
  const descriptors = useWorkspaceContextDescriptors(props.context.resource.environmentId).filter(
    (item) => item.clients.includes(props.context.client),
  );
  const snapshots = useMemo(() => readContextSnapshots(props.prompt), [props.prompt]);
  const [error, setError] = useState<string | null>(null);
  if (!descriptors.length && !snapshots.length) return null;
  return (
    <div className="flex flex-wrap items-start gap-2 px-3 py-2">
      {descriptors.length > 0 && (
        <Menu>
          <MenuTrigger render={<Button type="button" variant="outline" size="xs" />}>
            Add context
          </MenuTrigger>
          <MenuPopup align="start">
            {descriptors.map((descriptor) => (
              <MenuItem
                key={descriptor.id}
                onClick={() => {
                  try {
                    const snapshot = captureWorkspaceContext(descriptor.id, props.context);
                    props.onChange(appendContextSnapshot(props.prompt, snapshot));
                    setError(null);
                  } catch (cause) {
                    setError(cause instanceof Error ? cause.message : "Context unavailable");
                  }
                }}
              >
                {descriptor.title}
              </MenuItem>
            ))}
          </MenuPopup>
        </Menu>
      )}
      {snapshots.map(({ snapshot }) => (
        <div
          key={snapshot.id}
          className="flex max-w-full items-start gap-1 rounded-md border border-border/70 px-2 py-1 text-xs"
        >
          <details className="min-w-0">
            <summary className="cursor-pointer truncate">{snapshot.title}</summary>
            <p className="mt-1 text-muted-foreground">
              {snapshot.contributionId} · captured {snapshot.capturedAt}
            </p>
            <p className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words">
              {snapshot.text}
            </p>
            {snapshot.sourceUrl && (
              <p className="mt-1 break-all text-muted-foreground">{snapshot.sourceUrl}</p>
            )}
          </details>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            aria-label={"Remove context " + snapshot.title}
            onClick={() => {
              props.onChange(removeContextSnapshot(props.prompt, snapshot.id));
              setError(null);
            }}
          >
            Remove
          </Button>
        </div>
      ))}
      {error && (
        <p role="alert" className="w-full text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
