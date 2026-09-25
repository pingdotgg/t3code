import { ApprovalRequestId, EnvironmentId } from "@t3tools/contracts";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("react-native", () => ({
  View: "div",
  Pressable: ({ children }: { children: ReactNode }) => <button>{children}</button>,
  Image: "img",
  Linking: { openURL: vi.fn() },
}));
vi.mock("../../components/AppText", () => ({ AppText: "span" }));
vi.mock("../../state/assets", () => ({ useAssetUrl: () => null }));

import { QuestionAnswerHistory } from "./QuestionAnswerHistory";

describe("QuestionAnswerHistory", () => {
  it.each([{}, { text: "Text-only answer", file: "Answer with a file" }])(
    "renders attachment-only questions alongside text answers: %j",
    (answers) => {
      const markup = renderToStaticMarkup(
        <QuestionAnswerHistory
          environmentId={EnvironmentId.make("environment-local")}
          answer={{
            requestId: ApprovalRequestId.make("question-request"),
            answers,
            questionTextById: { file: "Provide a spec", image: "Provide a screenshot" },
            attachmentsByQuestionId: {
              file: [
                {
                  type: "file",
                  id: "spec",
                  name: "spec.txt",
                  mimeType: "text/plain",
                  sizeBytes: 4,
                },
              ],
              image: [
                {
                  type: "image",
                  id: "shot",
                  name: "shot.png",
                  mimeType: "image/png",
                  sizeBytes: 4,
                },
              ],
            },
          }}
        />,
      );
      expect(markup.match(/Provide a spec/g)).toHaveLength(1);
      expect(markup.match(/spec\.txt/g)).toHaveLength(1);
      expect(markup).toContain("Provide a screenshot");
      expect(markup).toContain("shot.png");
      for (const answer of Object.values(answers)) expect(markup).toContain(answer);
    },
  );
});
