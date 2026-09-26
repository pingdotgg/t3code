import { isElectron } from "../env";
import { useEffect, useMemo, useRef, useState } from "react";
import type { MessageContext } from "@t3tools/extension-sdk/context";
import {
  decorateWorkspaceMessage,
  useWorkspaceTextRevision,
  useWorkspaceHasMessageDecorations,
} from "./workspaceRegistry";

/** Read-only cards augment an immutable message; the row always retains its original text. */
export function MessageDecorations(props: { readonly message: MessageContext }) {
  const revision = useWorkspaceTextRevision();
  const enabled = useWorkspaceHasMessageDecorations();
  const { environmentId, threadId, messageId, text } = props.message;
  const container = useRef<HTMLDivElement>(null);
  const [visibility, setVisibility] = useState({ revision: -1, visible: false });
  const visible = visibility.revision === revision && visibility.visible;
  useEffect(() => {
    const element = container.current;
    if (!enabled || !element || typeof IntersectionObserver === "undefined") return;
    let active = true;
    const observer = new IntersectionObserver((entries) => {
      if (active)
        setVisibility({ revision, visible: entries.some((entry) => entry.isIntersecting) });
    });
    observer.observe(element);
    return () => {
      active = false;
      observer.disconnect();
    };
  }, [enabled, revision]);
  const cards = useMemo(
    () =>
      enabled && visible
        ? decorateWorkspaceMessage(
            { environmentId, threadId, messageId, text },
            isElectron ? "desktop" : "web",
            revision,
          )
        : [],
    [enabled, visible, environmentId, threadId, messageId, text, revision],
  );
  if (!enabled) return null;
  return (
    <div ref={container} className="min-h-px w-full">
      {cards.map((card) => (
        <aside
          key={card.contributionId}
          className="mt-2 rounded-md border border-border/60 p-2 text-xs"
        >
          <p className="font-medium">{card.title}</p>
          <p className="mt-1 whitespace-pre-wrap break-words text-muted-foreground">{card.text}</p>
          {card.sourceUrl && (
            <a
              href={card.sourceUrl}
              target="_blank"
              rel="noreferrer"
              className="mt-1 block break-all underline"
            >
              {card.sourceUrl}
            </a>
          )}
        </aside>
      ))}
    </div>
  );
}
