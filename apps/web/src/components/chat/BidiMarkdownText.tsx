import type { ReactNode } from "react";
import { markdownCodeParts, markdownPreview } from "~/textDirection";

export function BidiMarkdownText(props: { text: string; maxChars?: number }) {
  const parts =
    props.maxChars === undefined
      ? markdownCodeParts(props.text)
      : markdownPreview(props.text, props.maxChars).parts;
  const content: Array<ReactNode> = [];
  for (const part of parts) {
    const text = part.text;
    if (part.code) {
      content.push(
        <bdi dir="ltr" key={part.start}>
          {text}
        </bdi>,
      );
    } else {
      content.push(text);
    }
  }
  return content;
}
