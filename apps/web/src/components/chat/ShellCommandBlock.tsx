import {
  commandHighlightLanguage,
  withVisibleControlCharacters,
} from "@t3tools/client-runtime/work-log/command-label";
import { Suspense, use, useMemo } from "react";

import { useTheme } from "../../hooks/useTheme";
import { RenderErrorBoundary } from "../RenderErrorBoundary";
import { HighlightedTokens } from "./HighlightedTokens";

// Shell words wrap as a unit, so `--exclude` or a quoted string is not split
// at a hyphen; a word longer than the line still breaks anywhere.
const WORD_CLASS_NAME = "inline-block max-w-full [overflow-wrap:anywhere]";

// The shell parser loads with the first expanded command, not with the timeline.
let embeddedScriptsModule: Promise<typeof import("../../lib/embeddedScripts")> | undefined;
function loadEmbeddedScripts() {
  embeddedScriptsModule ??= import("../../lib/embeddedScripts");
  return embeddedScriptsModule;
}

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

function HighlightedCommand({ code, theme }: { code: string; theme: "light" | "dark" }) {
  const { embeddedScripts } = use(loadEmbeddedScripts());
  const language = commandHighlightLanguage(code);
  // Only shell syntax nests scripts; PowerShell's own grammar colors its strings.
  const embedded = useMemo(
    () => (language === "shellscript" ? embeddedScripts(code) : []),
    [code, embeddedScripts, language],
  );
  return (
    <HighlightedTokens
      code={code}
      language={language}
      embedded={embedded}
      theme={theme}
      wordClassName={WORD_CLASS_NAME}
    />
  );
}

/**
 * The command a command_execution item ran, syntax highlighted. Scripts inside
 * it, such as a `bash -lc` script or a Python heredoc, get their own grammar.
 */
export function ShellCommandBlock({ command }: { command: string }) {
  const { resolvedTheme } = useTheme();
  const code = withVisibleControlCharacters(command.trim());
  if (!code) return null;
  const plain = <PlainWords code={code} />;
  return (
    // The tool body sets the monospace, pre-wrapped text this sits in.
    <div className="text-foreground/85">
      <RenderErrorBoundary fallback={plain} resetKeys={[code]}>
        <Suspense fallback={plain}>
          <HighlightedCommand code={code} theme={resolvedTheme} />
        </Suspense>
      </RenderErrorBoundary>
    </div>
  );
}
