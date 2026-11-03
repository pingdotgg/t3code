import {
  commandHighlightLanguage,
  withVisibleControlCharacters,
} from "@t3tools/client-runtime/work-log/command-label";
import { Suspense, use } from "react";

import { useRenderedAppearance } from "../../hooks/useTheme";
import { RenderErrorBoundary } from "../RenderErrorBoundary";
import { HighlightedTokens } from "./HighlightedTokens";

const WORD_CLASS_NAME = "inline-block max-w-full [overflow-wrap:anywhere]";

let embeddedScriptsModule: Promise<typeof import("../../lib/embeddedScripts")> | undefined;
function loadEmbeddedScripts() {
  embeddedScriptsModule ??= import("../../lib/embeddedScripts");
  return embeddedScriptsModule;
}

// Match highlighted layout to prevent reflow when the grammar arrives.
function PlainWords({ code }: { code: string }) {
  return code.split(/(\s+)/u).map((part, index) =>
    index % 2 === 1 || part === "" ? (
      part
    ) : (
      // oxlint-disable-next-line react/no-array-index-key -- positions are stable for one string
      <span key={index} className={WORD_CLASS_NAME}>
        {part}
      </span>
    ),
  );
}

function HighlightedCommand({ code, theme }: { code: string; theme: "light" | "dark" }) {
  const { embeddedScripts } = use(loadEmbeddedScripts());
  const language = commandHighlightLanguage(code);
  const embedded = language === "shellscript" ? embeddedScripts(code) : [];
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

export function ShellCommandBlock({ command }: { command: string }) {
  const resolvedTheme = useRenderedAppearance();
  const code = withVisibleControlCharacters(command.trim());
  if (!code) return null;
  const plain = <PlainWords code={code} />;
  return (
    <div className="text-foreground/85">
      <RenderErrorBoundary fallback={plain} resetKeys={[code]}>
        <Suspense fallback={plain}>
          <HighlightedCommand code={code} theme={resolvedTheme} />
        </Suspense>
      </RenderErrorBoundary>
    </div>
  );
}
