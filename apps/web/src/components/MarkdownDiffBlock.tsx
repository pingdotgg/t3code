/** Displays both complete patches and headerless diff snippets without changing their source. */
export function MarkdownDiffBlock({ code }: { code: string }) {
  const lines = code.split("\n");
  if (lines.at(-1) === "") lines.pop();

  return (
    <pre className="chat-markdown-diff" aria-label="Diff">
      <code>
        {lines.map((line, index) => {
          const kind = /^(--- |\+\+\+ |diff |index )/.test(line)
            ? "header"
            : line.startsWith("@@")
              ? "hunk"
              : line.startsWith("+")
                ? "added"
                : line.startsWith("-")
                  ? "removed"
                  : "context";
          return (
            // Rows are stateless and identified by their position in the source.
            // eslint-disable-next-line react/no-array-index-key
            <span key={index} data-diff-line={kind}>
              {line}
              {index < lines.length - 1 || code.endsWith("\n") ? "\n" : null}
            </span>
          );
        })}
      </code>
    </pre>
  );
}
