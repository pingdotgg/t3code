import { useRef } from "react";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { ComposerHandleContext } from "~/composerHandleContext";
import { EnvironmentPluginHost } from "~/plugins/PluginHost";
import ChatView from "../ChatView";
import type { ChatComposerHandle } from "./ChatComposer";
import { definePluginComponent } from "~/plugins/features";

export interface EmbeddedThreadProps {
  readonly threadRef: ScopedThreadRef;
  readonly contextThreadRef?: ScopedThreadRef;
}

/** A normal durable thread, with its own composer and focus scope inside a panel. */
function BuiltinEmbeddedThread({ threadRef, contextThreadRef }: EmbeddedThreadProps) {
  const composerRef = useRef<ChatComposerHandle | null>(null);
  return (
    <EnvironmentPluginHost environmentId={threadRef.environmentId}>
      <ComposerHandleContext value={composerRef}>
        <ChatView
          routeKind="server"
          environmentId={threadRef.environmentId}
          threadId={threadRef.threadId}
          embedded
          {...(contextThreadRef === undefined ? {} : { contextThreadRef })}
          reserveTitleBarControlInset={false}
        />
      </ComposerHandleContext>
    </EnvironmentPluginHost>
  );
}

export const EmbeddedThread = definePluginComponent(
  "component:components/chat/EmbeddedThread/EmbeddedThread",
  BuiltinEmbeddedThread,
);
