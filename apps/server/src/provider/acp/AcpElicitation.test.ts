import type * as EffectAcpSchema from "effect-acp/schema";
import { describe, expect, it } from "vite-plus/test";

import {
  extractElicitationQuestions,
  makeElicitationAcceptedResponse,
  makeElicitationDeclinedResponse,
} from "./AcpElicitation.ts";

function formRequest(
  requestedSchema: Record<string, unknown>,
  message = "Configure the run",
): EffectAcpSchema.ElicitationRequest {
  return {
    mode: "form",
    message,
    sessionId: "session-1",
    requestedSchema,
  } as unknown as EffectAcpSchema.ElicitationRequest;
}

describe("AcpElicitation", () => {
  describe("extractElicitationQuestions", () => {
    it("marks properties absent from `required` as optional", () => {
      const questions = extractElicitationQuestions(
        formRequest({
          type: "object",
          properties: {
            color: { type: "string", description: "Pick a color", enum: ["red", "blue"] },
            notes: { type: "string", description: "Optional notes" },
          },
          required: ["color"],
        }),
      );

      const color = questions.find((question) => question.id === "color");
      const notes = questions.find((question) => question.id === "notes");
      expect(color?.optional).toBe(false);
      expect(notes?.optional).toBe(true);
      // Enum options are surfaced as selectable options.
      expect(color?.options.map((option) => option.label)).toEqual(["red", "blue"]);
    });

    it("treats all properties as optional when `required` is absent", () => {
      const questions = extractElicitationQuestions(
        formRequest({
          type: "object",
          properties: { notes: { type: "string" } },
        }),
      );
      expect(questions.every((question) => question.optional === true)).toBe(true);
    });

    it("emits a single required confirm question when there are no properties", () => {
      const questions = extractElicitationQuestions(
        formRequest({ type: "object", properties: {} }),
      );
      expect(questions).toHaveLength(1);
      expect(questions[0]?.id).toBe("confirm");
      expect(questions[0]?.optional).not.toBe(true);
    });

    it("returns no questions for url-mode elicitations", () => {
      const request = {
        mode: "url",
        message: "Open this",
        sessionId: "session-1",
        elicitationId: "e1",
        url: "https://example.com",
      } as unknown as EffectAcpSchema.ElicitationRequest;
      expect(extractElicitationQuestions(request)).toEqual([]);
    });
  });

  describe("makeElicitationAcceptedResponse", () => {
    const request = formRequest({
      type: "object",
      properties: {
        agree: { type: "boolean", title: "Proceed?" },
        count: { type: "integer", description: "How many" },
        ratio: { type: "number", description: "Ratio" },
        mode: {
          type: "string",
          oneOf: [
            { const: "fast", title: "Fast mode" },
            { const: "slow", title: "Slow mode" },
          ],
        },
        notes: { type: "string" },
      },
      required: ["agree"],
    });

    it("coerces recognized boolean answers", () => {
      expect(makeElicitationAcceptedResponse(request, { agree: "Yes" }).action).toMatchObject({
        action: "accept",
        content: { agree: true },
      });
      expect(makeElicitationAcceptedResponse(request, { agree: "No" }).action).toMatchObject({
        content: { agree: false },
      });
      expect(makeElicitationAcceptedResponse(request, { agree: "true" }).action).toMatchObject({
        content: { agree: true },
      });
    });

    it("omits unrecognized boolean answers instead of defaulting to false", () => {
      const response = makeElicitationAcceptedResponse(request, { agree: "maybe" });
      const content =
        response.action.action === "accept" ? (response.action.content ?? {}) : undefined;
      expect(content).toBeDefined();
      expect(content && "agree" in content).toBe(false);
    });

    it("coerces numeric and oneOf answers and maps titles back to const values", () => {
      const response = makeElicitationAcceptedResponse(request, {
        count: "42",
        ratio: "1.5",
        mode: "Fast mode",
      });
      expect(response.action).toMatchObject({
        action: "accept",
        content: { count: 42, ratio: 1.5, mode: "fast" },
      });
    });

    it("omits keys without an answer", () => {
      const response = makeElicitationAcceptedResponse(request, { agree: "Yes" });
      const content =
        response.action.action === "accept" ? (response.action.content ?? {}) : undefined;
      expect(content).toEqual({ agree: true });
    });
  });

  it("declines with a decline action", () => {
    expect(makeElicitationDeclinedResponse().action).toEqual({ action: "decline" });
  });
});
