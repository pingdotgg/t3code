import { expect, it } from "vite-plus/test";
import { relinkTriagePlaybook } from "./triagePrompt.ts";

// Destinations arrive URI-encoded, so a "(" in the path is %28.
const link = (home: string) =>
  `[triage-playbook.md](/home/${home}/.t3/userdata/triage/session%20%281%29/triage-playbook.md)`;
const prepared = `Read ${link("b")} and follow it. `;

it.each([
  ["the fresh prompt", `Read ${link("a")} and follow it. `, prepared],
  [
    "text the user wrote around the link",
    `Hi. Read ${link("a")} and follow it. The app crashes on launch.`,
    `Hi. Read ${link("b")} and follow it. The app crashes on launch.`,
  ],
  ["a prompt whose link the user removed", "The app crashes.", "The app crashes."],
])("relinkTriagePlaybook keeps %s", (_, prompt, expected) => {
  expect(relinkTriagePlaybook(prompt, prepared)).toBe(expected);
});
