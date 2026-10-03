import {
  commandDisplayText,
  commandHighlightLanguage,
} from "@t3tools/client-runtime/work-log/command-label";
import { Suspense } from "react";

import { useTheme } from "../../hooks/useTheme";
import { RenderErrorBoundary } from "../RenderErrorBoundary";
import { HighlightedTokens } from "./HighlightedTokens";

// Shell words wrap as a unit, so `--exclude` or a quoted string is not split
// at a hyphen; a word longer than the line still breaks anywhere.
const WORD_CLASS_NAME = "inline-block max-w-full [overflow-wrap:anywhere]";

/** Same layout as the highlighted version, so the grammar arriving never reflows the block. */
function PlainWords({ code }: { code: string }) {
  // split with a capture group alternates words (even) and whitespace (odd).
  return code.split(/(\s+)/u).map((part, index) =>
    index % 2 === 1 || part === "" ? (
      part
    ) : (
      // Positions are stable for a given string, which is all this renders.
      // oxlint-disable-next-line react/no-array-index-key
      <span key={index} className={WORD_CLASS_NAME}>
        {part}
      </span>
    ),
  );
}

/** The command a command_execution item ran, without a `bash -lc` wrapper, syntax highlighted. */
export function ShellCommandBlock({ command }: { command: string }) {
  const { resolvedTheme } = useTheme();
  const code = commandDisplayText(command);
  if (!code) return null;
  const plain = <PlainWords code={code} />;
  return (
    <pre className="max-h-80 overflow-auto whitespace-pre-wrap rounded-md border border-border/50 bg-background/60 p-2 font-mono text-2xs leading-relaxed text-foreground/85 select-text">
      <RenderErrorBoundary fallback={plain} resetKeys={[code]}>
        <Suspense fallback={plain}>
          <HighlightedTokens
            code={code}
            language={commandHighlightLanguage(code)}
            theme={resolvedTheme}
            wordClassName={WORD_CLASS_NAME}
          />
        </Suspense>
      </RenderErrorBoundary>
    </pre>
  );
}
