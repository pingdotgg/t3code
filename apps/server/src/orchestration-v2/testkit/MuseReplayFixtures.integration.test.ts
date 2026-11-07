import { projectionFor } from "./fixtures/shared.ts";
import type { ProviderReplayEntry } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";

import {
  materializeMuseReplayWorkspace,
  MuseOrchestratorReplayHarness,
} from "../Adapters/MuseAdapterV2.testkit.ts";
import {
  findReplayFixture,
  itRunsReplayFixtures,
  runReplayFixture,
} from "./ProviderReplayFixtures.ts";

describe("Muse replay fixtures", () => {
  itRunsReplayFixtures("muse", (input) =>
    runReplayFixture({
      ...input,
      harness: MuseOrchestratorReplayHarness,
      materializeWorkspace: materializeMuseReplayWorkspace,
    }),
  );
  it.effect(
    "keeps Muse answers and decisions across native acknowledgement and turn cleanup",
    () => {
      const fixture = findReplayFixture("simple");
      const provider = fixture?.providers.find((candidate) => candidate.driver === "muse");
      assert.isDefined(fixture);
      assert.isDefined(provider);
      const answers = { approach: ["Small", "Keep tests focused"] };
      return runReplayFixture({
        harness: MuseOrchestratorReplayHarness,
        materializeWorkspace: materializeMuseReplayWorkspace,
        fixtureName: fixture.name,
        buildInput: () => ({
          ...fixture.buildInput(),
          steps: [
            ...fixture.buildInput().steps,
            { type: "answer_next_user_input_request", answers },
            { type: "answer_next_user_input_request", answers },
            { type: "approve_next_runtime_request", decision: "acceptForSession" },
          ],
        }),
        driver: {
          ...provider,
          assertOutput: (result) => {
            const projection = projectionFor(result, fixture.name);
            assert.equal(projection.runs.at(-1)?.status, "completed");
            assert.lengthOf(projection.runtimeRequests, 3);
            const observed = [];
            const expected = [];
            for (const nativeId of ["question-ack", "question-no-ack", "approval-no-ack"]) {
              const request = projection.runtimeRequests.find(
                (candidate) => candidate.nativeRequestRef?.nativeId === nativeId,
              );
              assert.isDefined(request);
              const card = projection.turnItems.find((item) => item.nodeId === request.nodeId);
              const node = projection.nodes.find((candidate) => candidate.id === request.nodeId);
              const isQuestion = request.kind === "user_input";
              const response = isQuestion ? { answers } : { decision: "acceptForSession" as const };
              const submitted = result.domainEvents.find(
                (event) =>
                  event.type === "runtime-request.updated" &&
                  event.payload.id === request.id &&
                  event.payload.status === "resolved",
              );
              assert.isDefined(submitted, `${nativeId} was persisted before native delivery`);
              assert.deepInclude(submitted.payload, response);
              if (!isQuestion) {
                const assistantItemIndex = result.domainEvents.findIndex(
                  (event) =>
                    event.type === "turn-item.updated" &&
                    event.payload.type === "assistant_message",
                );
                const submittedIndex = result.domainEvents.indexOf(submitted);
                assert.isAbove(assistantItemIndex, submittedIndex);
                // The next assistant item is persisted after stageResolved, before turn cleanup.
                const beforeAssistant = result.domainEvents.slice(0, assistantItemIndex);
                const requestAtUpdate = beforeAssistant.findLast(
                  (event) =>
                    event.type === "runtime-request.updated" && event.payload.id === request.id,
                );
                const nodeAtUpdate = beforeAssistant.findLast(
                  (event) => event.type === "node.updated" && event.payload.id === request.nodeId,
                );
                const cardAtUpdate = beforeAssistant.findLast(
                  (event) =>
                    event.type === "turn-item.updated" && event.payload.nodeId === request.nodeId,
                );
                assert.deepInclude(
                  requestAtUpdate?.payload,
                  { status: "resolved", decision: "acceptForSession" },
                  "stageResolved must preserve the persisted T3 decision before turn cleanup",
                );
                assert.deepInclude(nodeAtUpdate?.payload, { status: "completed" });
                assert.deepInclude(cardAtUpdate?.payload, { status: "completed" });
              }
              observed.push({
                nativeId,
                status: request.status,
                answers: request.answers,
                decision: request.decision,
                nodeStatus: node?.status,
                cardStatus: card?.status,
                questionAnswer:
                  card?.type === "user_input_request" ? card.questionAnswer : undefined,
              });
              expected.push({
                nativeId,
                status: "resolved",
                answers: isQuestion ? answers : undefined,
                decision: isQuestion ? undefined : "acceptForSession",
                nodeStatus: "completed",
                cardStatus: "completed",
                questionAnswer: isQuestion
                  ? {
                      requestId: request.id,
                      answers,
                      attachmentsByQuestionId: {},
                      questionTextById: { approach: "Which approach?" },
                    }
                  : undefined,
              } as const);
            }
            assert.deepEqual(observed, expected);
          },
        },
        transformTranscript: (transcript) => {
          const at = transcript.entries.findIndex(
            (entry) => entry.type === "emit_inbound" && entry.label === "turn/started",
          );
          const started = transcript.entries[at];
          assert.isDefined(started);
          if (started.type !== "emit_inbound") assert.fail("Missing Muse turn/started");
          const { sessionId, turnId } = (
            started.frame as {
              readonly params: { readonly sessionId: string; readonly turnId: string };
            }
          ).params;
          const metadata = transcript.metadata as {
            readonly commandIds: ReadonlyArray<ReadonlyArray<string>>;
          };
          return {
            ...transcript,
            metadata: {
              ...transcript.metadata,
              commandIds: [
                [...metadata.commandIds[0]!, "answer-ack", "answer-no-ack", "approve-no-ack"],
              ],
            },
            entries: [
              ...transcript.entries.slice(0, at + 1),
              ...["question-ack", "question-no-ack"].flatMap(
                (userInputId, index): ProviderReplayEntry[] => [
                  {
                    type: "emit_inbound",
                    frame: {
                      jsonrpc: "2.0",
                      method: "userInput/requested",
                      params: {
                        sessionId,
                        turnId,
                        userInputId,
                        questions: [
                          {
                            id: "approach",
                            header: "Approach",
                            question: "Which approach?",
                            options: [{ label: "Small" }, { label: "Large" }],
                            selection: { mode: "single" },
                          },
                        ],
                      },
                    },
                  },
                  {
                    type: "expect_outbound",
                    frame: {
                      jsonrpc: "2.0",
                      id: 4 + index,
                      method: "userInput/answer",
                      params: {
                        sessionId,
                        userInputId,
                        commandId: index === 0 ? "answer-ack" : "answer-no-ack",
                        answers: [
                          {
                            questionId: "approach",
                            selectedLabel: "Small",
                            note: "Keep tests focused",
                          },
                        ],
                      },
                    },
                  },
                  { type: "emit_inbound", frame: { jsonrpc: "2.0", id: 4 + index, result: {} } },
                  ...(index === 0
                    ? [
                        {
                          type: "emit_inbound" as const,
                          frame: {
                            jsonrpc: "2.0",
                            method: "userInput/settled",
                            params: { sessionId, turnId, userInputId },
                          },
                        },
                      ]
                    : []),
                ],
              ),
              {
                type: "emit_inbound",
                frame: {
                  jsonrpc: "2.0",
                  method: "approval/requested",
                  params: {
                    sessionId,
                    turnId,
                    approvalId: "approval-no-ack",
                    currentRequirementId: { approvalId: "approval-no-ack", sourceIndex: 0 },
                    availableChoices: [
                      {
                        choiceId: "session",
                        label: "Allow for session",
                        decision: "approvedForSession",
                        scope: "session",
                      },
                    ],
                    subject: { kind: "shell", command: "touch result.txt" },
                  },
                },
              },
              {
                type: "expect_outbound",
                frame: {
                  jsonrpc: "2.0",
                  id: 6,
                  method: "approval/decide",
                  params: {
                    sessionId,
                    approvalId: "approval-no-ack",
                    commandId: "approve-no-ack",
                    requirementId: { approvalId: "approval-no-ack", sourceIndex: 0 },
                    choiceId: "session",
                  },
                },
              },
              { type: "emit_inbound", frame: { jsonrpc: "2.0", id: 6, result: {} } },
              {
                type: "emit_inbound",
                frame: {
                  jsonrpc: "2.0",
                  method: "approval/updated",
                  params: {
                    sessionId,
                    turnId,
                    approvalId: "approval-no-ack",
                    currentRequirementId: { approvalId: "approval-no-ack", sourceIndex: 0 },
                    availableChoices: [
                      {
                        choiceId: "session",
                        label: "Allow for session",
                        decision: "approvedForSession",
                        scope: "session",
                      },
                    ],
                    subject: { kind: "shell", command: "touch result.txt" },
                    change: {
                      kind: "stageResolved",
                      requirementId: { approvalId: "approval-no-ack", sourceIndex: 0 },
                      choiceId: "session",
                      decision: "approvedForSession",
                    },
                  },
                },
              },
              ...transcript.entries.slice(at + 1),
            ],
          };
        },
      });
    },
  );
});
