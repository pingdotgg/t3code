import { expect, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import { parseAgentSessionTranscript } from "./AgentSessionScanner.ts";

function parseClaudeTurns(userTurns: ReadonlyArray<string>) {
  return parseAgentSessionTranscript({
    contents: [
      ...userTurns.map((content) => ({ type: "user", message: { role: "user", content } })),
      { type: "assistant", message: { role: "assistant", content: "Here is what happened." } },
    ]
      .map((record) => JSON.stringify(record))
      .join("\n"),
    source: "claudeAgent",
    providerInstanceId: ProviderInstanceId.make("claudeAgent"),
    fallbackSessionId: "62c057bb-b316-4b29-be2c-140090d71254",
    lastActiveAtMs: Date.parse("2026-08-24T12:00:00.000Z"),
  });
}

it("hides shell output that ends with its own closing tag", () => {
  const thread = parseClaudeTurns([
    "<bash-stdout></bash-stdout>\n</bash-stdout><bash-stderr></bash-stderr>",
    "What happened?",
  ]);

  expect(
    thread?.messages.filter((message) => message.role === "user").map((message) => message.text),
  ).toEqual(["What happened?"]);
});

it("uses the prose after quoted command output to name the thread", () => {
  const question = "Why did this change?";
  const prompt = `<local-command-stdout>Enabled plan mode</local-command-stdout>\n${question}`;

  expect(parseClaudeTurns([prompt])).toMatchObject({
    title: question,
    messages: [{ role: "user", text: prompt }, { role: "assistant" }],
  });
});

it.each(["<command-name>/review</command-name>", "<command-message>review</command-message>"])(
  "keeps a prompt that quotes %s before a question",
  (quote) => {
    const prompt = `${quote}\nWhy did this fail?`;

    expect(parseClaudeTurns([prompt])?.messages[0]).toMatchObject({ role: "user", text: prompt });
  },
);
