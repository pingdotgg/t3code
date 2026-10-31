import { useNavigate } from "@tanstack/react-router";
import { CheckIcon, PlugIcon } from "lucide-react";

import { Button } from "../ui/button";
import { LinearGlyph } from "./linearIcons";

const BULLETS = [
  "Read issues, projects, milestones, cycles and custom views.",
  "Post status back as issue comments (optional).",
  "Your API key stays on the T3 server, in its secret store.",
] as const;

/** Shown when Linear is not connected, or its stored key was rejected (`invalid`). */
export function LinearConnectCard({ invalid }: { invalid: boolean }) {
  const navigate = useNavigate();
  return (
    <div className="flex flex-1 items-center justify-center p-10">
      <div
        data-testid="linear-connect-card"
        className="flex w-[420px] max-w-full flex-col gap-4 rounded-2xl border border-border bg-card p-7 shadow-xl"
      >
        <div className="flex items-center gap-2.5">
          <span className="inline-flex size-10 items-center justify-center rounded-lg border border-border bg-background text-sm font-bold">
            T3
          </span>
          <PlugIcon aria-hidden className="size-3.5 text-muted-foreground" />
          <span className="inline-flex size-10 items-center justify-center rounded-lg border border-border bg-background">
            <LinearGlyph className="size-[22px]" />
          </span>
        </div>
        <h2 className="m-0 text-lg font-semibold tracking-tight">
          {invalid ? "Reconnect Linear" : "Connect Linear"}
        </h2>
        <p className="m-0 text-sm leading-relaxed text-muted-foreground">
          {invalid
            ? "Your Linear API key is no longer valid. Paste a new key."
            : "Browse your teams, projects and milestones, and turn any issue into a chat or pipeline run. T3 links threads and PRs back to issues by branch name."}
        </p>
        <ul className="m-0 flex list-none flex-col gap-1.5 p-0 text-xs">
          {BULLETS.map((bullet) => (
            <li key={bullet} className="flex items-center gap-2">
              <CheckIcon aria-hidden className="size-3.5 shrink-0 text-success-foreground" />
              {bullet}
            </li>
          ))}
        </ul>
        <Button
          size="lg"
          onClick={() => void navigate({ to: "/settings/linear" })}
          data-testid="linear-connect-button"
        >
          {invalid ? "Reconnect with API key" : "Connect with API key"}
        </Button>
      </div>
    </div>
  );
}
