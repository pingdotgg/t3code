import { createFileRoute } from "@tanstack/react-router";
import { SharedThread } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { ArrowUpRightIcon, LinkIcon } from "lucide-react";
import { SharedConversation } from "../components/chat/SharedConversation";
import { Button } from "../components/ui/button";
import { useCopyToClipboard } from "../hooks/useCopyToClipboard";

export const Route = createFileRoute("/share/$code")({
  loader: async ({ params, abortController }) => {
    const response = await fetch(`/api/shares/${encodeURIComponent(params.code)}`, {
      signal: abortController.signal,
      credentials: "omit",
      cache: "no-store",
    });
    if (response.status === 400 || response.status === 404) return null;
    if (!response.ok) throw new Error("This shared chat could not be loaded. Please try again.");
    return Schema.decodeUnknownSync(SharedThread)(await response.json());
  },
  component: SharePage,
  pendingComponent: () => (
    <div className="grid h-dvh place-items-center text-sm text-muted-foreground">
      Loading shared chat…
    </div>
  ),
  errorComponent: ({ error }) => (
    <div className="grid h-dvh place-content-center gap-4 p-6 text-center">
      <p>{error.message}</p>
      <Button onClick={() => window.location.reload()}>Try again</Button>
    </div>
  ),
  head: ({ loaderData }) => ({
    meta: [
      { title: loaderData ? `${loaderData.title} · T3 Code` : "Shared chat · T3 Code" },
      { name: "robots", content: "noindex, nofollow" },
      { name: "referrer", content: "no-referrer" },
    ],
  }),
});

function SharePage() {
  const share = Route.useLoaderData();
  const { copyToClipboard, isCopied } = useCopyToClipboard();
  return (
    <div className="h-dvh overflow-y-auto bg-background text-foreground">
      <header className="border-b border-border/60">
        <div className="mx-auto flex h-16 max-w-5xl items-center justify-between px-5 sm:px-8">
          <a
            href="https://t3.codes"
            className="flex items-center gap-2.5 font-semibold tracking-tight"
          >
            <img src="/apple-touch-icon.png" alt="" className="size-7 rounded-lg" />
            T3 Code
            <span className="ml-2 border-l border-border pl-4 text-xs font-normal tracking-normal text-muted-foreground">
              Shared chat
            </span>
          </a>
          <Button
            variant="ghost"
            size="sm"
            render={<a href="https://t3.codes" target="_blank" rel="noopener noreferrer" />}
          >
            Get T3 Code
            <ArrowUpRightIcon />
          </Button>
        </div>
      </header>
      {share ? (
        <main className="mx-auto max-w-[52rem] px-5 pb-20 pt-12 sm:px-8 sm:pt-16">
          <div className="mb-10 border-b border-border/60 pb-8">
            <div className="mb-4 flex items-center gap-2 text-xs text-muted-foreground">
              <LinkIcon className="size-3.5" />
              <span>Conversation snapshot</span>
              <span>·</span>
              <time dateTime={share.createdAt}>
                {new Date(share.createdAt).toLocaleDateString(undefined, {
                  month: "long",
                  day: "numeric",
                  year: "numeric",
                })}
              </time>
            </div>
            <h1 className="text-2xl font-semibold leading-tight tracking-tight sm:text-3xl">
              {share.title}
            </h1>
            <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
              <p className="text-xs text-muted-foreground">
                {share.messages.length} messages{share.provider ? ` · ${share.provider}` : ""}
                {share.tools.length ? ` · ${share.tools.length} tool calls` : ""}
              </p>
              <Button
                variant="outline"
                size="sm"
                onClick={() => copyToClipboard(window.location.href, undefined)}
              >
                <LinkIcon />
                {isCopied ? "Copied" : "Copy link"}
              </Button>
            </div>
          </div>
          <SharedConversation share={share} />
          <footer className="mt-12 border-t border-border/60 pt-6 text-xs leading-6 text-muted-foreground">
            Shared from T3 Code. This is a snapshot; later messages are not included. AI responses
            may contain mistakes.
          </footer>
        </main>
      ) : (
        <main className="mx-auto max-w-lg px-6 py-24 text-center">
          <h1 className="text-2xl font-semibold">This share is unavailable</h1>
          <p className="mt-3 text-sm text-muted-foreground">
            The link may have been revoked, or the address is incorrect.
          </p>
        </main>
      )}
    </div>
  );
}
