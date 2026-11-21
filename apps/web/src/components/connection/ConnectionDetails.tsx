import { useAtomValue } from "@effect/atom-react";
import {
  attemptLogToText,
  describeAttemptLogEntry,
  type AttemptLogTone,
} from "@lathe/client-runtime/connection";
import type { DesktopSshEnvironmentTarget } from "@lathe/contracts";
import * as Option from "effect/Option";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import { useLayoutEffect, useRef, type ReactNode } from "react";

import { environmentCatalog } from "~/connection/catalog";
import { useSshEnvironmentOutput } from "~/connection/sshOutput";
import { namedClipboardTarget, useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { usePrimarySettings } from "~/hooks/useSettings";
import { cn } from "~/lib/utils";
import type { EnvironmentPresentation } from "~/state/environments";
import { getTimestampFormatter } from "~/timestampFormat";
import { Button } from "../ui/button";

const TONE_TEXT: Record<AttemptLogTone, string> = {
  muted: "text-muted-foreground",
  success: "text-success-foreground",
  warning: "text-warning-foreground",
  error: "text-error-foreground",
};

/** The environment's saved SSH target, when the desktop app brings it up over SSH. */
function sshTargetOf(environment: EnvironmentPresentation): DesktopSshEnvironmentTarget | null {
  const { entry } = environment;
  return entry.target._tag === "SshConnectionTarget" &&
    Option.isSome(entry.profile) &&
    entry.profile.value._tag === "SshConnectionProfile"
    ? entry.profile.value.target
    : null;
}

/**
 * Scrollable monospace log that follows new lines only while it is scrolled to the bottom, so
 * reading earlier output is never yanked away. Jumps rather than animates.
 */
function DetailsLog({
  label,
  empty,
  children,
  count,
}: {
  readonly label: string;
  readonly empty: string;
  readonly children: ReactNode;
  readonly count: number;
}) {
  const ref = useRef<HTMLPreElement>(null);
  const atBottom = useRef(true);
  // After every render, which here means new lines: cheap, and never a smooth scroll.
  // oxlint-disable-next-line lathe/no-unreasoned-state-sync -- keeps the log element scrolled to the bottom after new lines unless the user scrolled up
  useLayoutEffect(() => {
    const element = ref.current;
    if (element && atBottom.current) element.scrollTop = element.scrollHeight;
  });
  return (
    <section className="flex min-w-0 flex-col gap-1">
      <h3 className="font-medium text-muted-foreground text-xs">{label}</h3>
      <pre
        ref={ref}
        onScroll={(event) => {
          const element = event.currentTarget;
          atBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 8;
        }}
        className="max-h-48 overflow-auto rounded-md border border-border bg-code px-2.5 py-1.5 font-mono text-2xs leading-relaxed whitespace-pre-wrap break-words select-text"
      >
        {count === 0 ? <span className="text-muted-foreground">{empty}</span> : children}
      </pre>
    </section>
  );
}

/**
 * What connecting to an environment has been doing: every attempt's steps and failures, and for
 * a desktop-managed SSH environment what bringing it up printed. Mount it only while shown; it
 * follows the attempt log and SSH output for as long as it is mounted.
 */
export function ConnectionDetails({
  environment,
}: {
  readonly environment: EnvironmentPresentation;
}) {
  const attempts = Option.getOrElse(
    AsyncResult.value(useAtomValue(environmentCatalog.attemptLogAtom(environment.environmentId))),
    () => [],
  );
  const sshTarget = sshTargetOf(environment);
  const sshOutput = useSshEnvironmentOutput(sshTarget);
  const timestampFormat = usePrimarySettings((settings) => settings.timestampFormat);
  const time = getTimestampFormatter(timestampFormat, true);
  const { copyToClipboard, isCopied } = useCopyToClipboard({
    target: namedClipboardTarget("connection details"),
  });

  return (
    <div className="flex min-w-0 flex-col gap-2">
      <DetailsLog label="Connection attempts" empty="No attempts yet." count={attempts.length}>
        {attempts.map((entry) => {
          const { text, tone } = describeAttemptLogEntry(entry);
          return (
            <div
              key={`${entry.at}:${entry.attempt}:${entry.kind}:${entry.kind === "stage" ? entry.stage : ""}`}
              className={TONE_TEXT[tone]}
            >
              <span className="text-muted-foreground/70">{time.format(entry.at)} </span>
              {text}
            </div>
          );
        })}
      </DetailsLog>
      {sshTarget ? (
        <DetailsLog label="SSH output" empty="Nothing printed yet." count={sshOutput.length}>
          {sshOutput.map((entry) => (
            // ssh writes progress to stderr too, so only attempt markers stand out.
            <div
              key={entry.seq}
              className={cn(
                entry.source === "status" ? "font-medium text-foreground" : "text-muted-foreground",
              )}
            >
              <span className="text-muted-foreground/70">{time.format(Date.parse(entry.at))} </span>
              {entry.text}
            </div>
          ))}
        </DetailsLog>
      ) : null}
      <div>
        <Button
          size="xs"
          variant="ghost"
          onClick={() => copyToClipboard(attemptLogToText(attempts, sshOutput))}
        >
          {isCopied ? "Copied" : "Copy details"}
        </Button>
      </div>
    </div>
  );
}
