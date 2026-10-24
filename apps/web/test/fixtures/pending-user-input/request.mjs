import * as NodeFS from "node:fs";

const fixtures = JSON.parse(
  NodeFS.readFileSync(new URL("./questions.json", import.meta.url), "utf8"),
);
const shape = process.argv[2] ?? "multi";
if (shape !== "multi" && shape !== "single") {
  throw new Error("Usage: node request.mjs [multi|single]");
}

console.log(
  "Call only AskUserQuestion with the questions below. Do not execute commands, edit files, " +
    "or use other tools. Preserve the text exactly, including the description newline. " +
    "The id fields are fixture identifiers; omit them if the provider schema disallows them. " +
    "Leave the request pending. When answered, acknowledge the choices without taking action.\n\n" +
    JSON.stringify({ questions: fixtures[shape] }, null, 2),
);
