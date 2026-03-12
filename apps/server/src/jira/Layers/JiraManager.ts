import { Effect, Layer } from "effect";

import { JiraCli } from "../Services/JiraCli.ts";
import { JiraManager, type JiraManagerShape } from "../Services/JiraManager.ts";
import { TextGeneration } from "../../git/Services/TextGeneration.ts";

function limitContext(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n\n[truncated]`;
}

export const makeJiraManager = Effect.gen(function* () {
  const jiraCli = yield* JiraCli;
  const textGeneration = yield* TextGeneration;

  const viewIssue: JiraManagerShape["viewIssue"] = (input) => jiraCli.viewIssue(input);

  const createIssue: JiraManagerShape["createIssue"] = (input) => jiraCli.createIssue(input);

  const moveIssue: JiraManagerShape["moveIssue"] = (input) => jiraCli.moveIssue(input);

  const addComment: JiraManagerShape["addComment"] = (input) => jiraCli.addComment(input);

  const listIssues: JiraManagerShape["listIssues"] = (input) => jiraCli.listIssues(input);

  const generateTicketContent: JiraManagerShape["generateTicketContent"] = (input) =>
    textGeneration.generateJiraTicketContent({
      conversationContext: limitContext(input.conversationContext, 20_000),
      projectKey: input.projectKey,
    });

  const generateProgressComment: JiraManagerShape["generateProgressComment"] = (input) =>
    textGeneration.generateJiraProgressComment({
      ticketKey: input.ticketKey,
      ticketTitle: input.ticketTitle,
      recentConversation: limitContext(input.recentConversation, 20_000),
    });

  const generateCompletionSummary: JiraManagerShape["generateCompletionSummary"] = (input) =>
    textGeneration.generateJiraCompletionSummary({
      ticketKey: input.ticketKey,
      ticketTitle: input.ticketTitle,
      fullConversation: limitContext(input.fullConversation, 30_000),
    });

  return {
    viewIssue,
    createIssue,
    moveIssue,
    addComment,
    listIssues,
    generateTicketContent,
    generateProgressComment,
    generateCompletionSummary,
  } satisfies JiraManagerShape;
});

export const JiraManagerLive = Layer.effect(JiraManager, makeJiraManager);
