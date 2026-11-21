import { isDocumentCitation, renderCitationsAsText } from "@lathe/shared/assistantCitations";

/** Document quotes have no chip on mobile, so they read as blockquotes; assistant quotes stay links. */
export function flattenDocumentQuotes(text: string): string {
  return renderCitationsAsText(text, isDocumentCitation);
}
