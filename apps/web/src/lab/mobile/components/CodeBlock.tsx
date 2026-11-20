import { Fragment, useState } from "react";
import { Icon } from "./Icon";
import "./CodeBlock.css";

const KEYWORDS =
  /^(const|let|var|export|import|from|return|function|if|else|new|await|async|class|type|interface)$/;

/** A tiny highlighter for the lab: keywords, strings, builtins, operators. */
function highlight(line: string) {
  const parts = line.match(/"[^"]*"|'[^']*'|\w+|\s+|[^\w\s]/g) ?? [];
  let offset = 0;
  return parts.map((part) => {
    const key = offset;
    offset += part.length;
    let kind: string | null = null;
    if (/^["']/.test(part)) kind = "string";
    else if (KEYWORDS.test(part)) kind = "keyword";
    else if (/^[A-Z]\w*$/.test(part)) kind = "builtin";
    else if (/^[=+\-*/<>|&]+$/.test(part)) kind = "operator";
    else if (/^[[\](){};,.:]$/.test(part)) kind = "punct";
    return kind ? (
      <span key={key} data-syn={kind}>
        {part}
      </span>
    ) : (
      <Fragment key={key}>{part}</Fragment>
    );
  });
}

function label(language: string | undefined) {
  if (!language) return null;
  return language.charAt(0).toUpperCase() + language.slice(1);
}

/**
 * A code block as the app draws it: one rounded surface, the language and quiet wrap/copy actions on
 * a row above the code, no divider (apps/mobile CodeBlockFrame). The first row is the 30pt strip.
 */
export function CodeBlock(props: {
  readonly code: string;
  readonly language?: string | undefined;
}) {
  const [wrap, setWrap] = useState(false);
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard?.writeText(props.code).catch(() => undefined);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  };
  return (
    <div className="m-code m-continuous">
      <div className="m-code-header">
        <span className="m-code-label">{label(props.language)}</span>
        <span className="m-code-actions">
          {props.language ? (
            <button
              className="m-code-button"
              data-active={wrap}
              aria-label="Wrap lines"
              onClick={() => setWrap(!wrap)}
            >
              <Icon name="wrap-lines" size={15} />
            </button>
          ) : null}
          <button className="m-code-button" aria-label="Copy code" onClick={copy}>
            <Icon name={copied ? "check" : "copy"} size={15} />
          </button>
        </span>
      </div>
      <pre className="m-code-body" data-wrap={wrap}>
        {props.code.split("\n").map((line, index) => (
          // oxlint-disable-next-line react/no-array-index-key -- static lines
          <div key={index}>{highlight(line) || " "}</div>
        ))}
      </pre>
    </div>
  );
}
