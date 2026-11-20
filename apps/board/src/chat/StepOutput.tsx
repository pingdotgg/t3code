const MAX_OUTPUT_LINES = 400;

export function StepOutput({ text, failed }: { text: string; failed: boolean }) {
  const lines = text.split("\n");
  const shown = lines.length > MAX_OUTPUT_LINES ? lines.slice(-MAX_OUTPUT_LINES) : lines;
  return (
    <>
      {shown.length < lines.length && (
        <p className="text-faint">… {lines.length - shown.length} earlier lines</p>
      )}
      <pre
        data-testid="step-output"
        className={`max-h-64 overflow-auto rounded-md border bg-bg p-2 font-mono text-[11px] leading-4 break-words whitespace-pre-wrap ${failed ? "border-red-400/40 text-red-300" : "border-line text-muted"}`}
      >
        {shown.join("\n")}
      </pre>
    </>
  );
}
