function notebookStream(output: unknown) {
  if (
    !output ||
    typeof output !== "object" ||
    !("output_type" in output) ||
    output.output_type !== "stream" ||
    !("name" in output) ||
    (output.name !== "stdout" && output.name !== "stderr") ||
    !("text" in output) ||
    (typeof output.text !== "string" && !Array.isArray(output.text)) ||
    "data" in output
  ) {
    return undefined;
  }
  return { name: output.name, text: output.text };
}

export function* notebookOutputGroups(
  outputs: readonly unknown[],
  readText: (value: unknown) => string,
) {
  let streamName: string | undefined;
  let chunks: string[] = [];
  for (const output of outputs) {
    const stream = notebookStream(output);
    if (streamName !== undefined && streamName !== stream?.name) {
      yield { kind: "stream" as const, text: chunks.join("") };
      chunks = [];
    }
    streamName = stream?.name;
    if (stream) chunks.push(readText(stream.text));
    else yield { kind: "output" as const, output };
  }
  if (streamName !== undefined) yield { kind: "stream" as const, text: chunks.join("") };
}
