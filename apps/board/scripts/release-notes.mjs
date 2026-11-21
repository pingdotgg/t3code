#!/usr/bin/env node
// Writes release-notes.md: a short Claude summary over GitHub's generated list, the way
// scripts/generate-release-notes.ts does for T3. Without a key, a previous tag, or a working
// call, the file holds GitHub's list alone.
// Usage: node apps/board/scripts/release-notes.mjs --repository <owner/name> --tag <tag> --ref <sha> --output <file>
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeUtil from "node:util";
import * as NodeURL from "node:url";

const TAG_PREFIX = "board-v";
const SUMMARY_MODEL = "claude-sonnet-5-5";
const PULL_REQUEST_BODY_LIMIT = 600;

const SUMMARY_INSTRUCTIONS = `Write up to 5 bullet points telling the operator of Agent Board what changed in this release. Say what they can now do or what now works, in one sentence of at most 20 words each. Skip internal work, docs, tests, and dependency bumps. No title, heading, introduction, PR numbers, or em dashes. Return only the bullets.`;

/** The release tag just before `tag` among the `board-v*` tags, so upstream's `v*` tags never count. */
export function previousTag(tags, tag) {
  const boardTags = [...new Set([...tags.filter((name) => name.startsWith(TAG_PREFIX)), tag])];
  boardTags.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  return boardTags[boardTags.indexOf(tag) - 1];
}

/** The summary on top, GitHub's full list below. */
export function assembleNotes(summary, list) {
  return `${summary.trim()}\n\n${list.trim()}\n`;
}

const pullNumbers = (list) => [...new Set([...list.matchAll(/\/pull\/(\d+)/g)].map((m) => m[1]))];

const run = (command, args) =>
  NodeChildProcess.execFileSync(command, args, { encoding: "utf8" }).trim();

function readPullRequests(repository, list) {
  return pullNumbers(list)
    .map((number) => {
      const { title, body } = JSON.parse(run("gh", ["api", `repos/${repository}/pulls/${number}`]));
      const text = (body ?? "").replace(/\s+/g, " ").trim().slice(0, PULL_REQUEST_BODY_LIMIT);
      return `- ${title}\n  ${text}`;
    })
    .join("\n");
}

async function summarize(pullRequests, apiKey) {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: SUMMARY_MODEL,
      max_tokens: 1024,
      output_config: { effort: "medium" },
      system: SUMMARY_INSTRUCTIONS,
      messages: [
        { role: "user", content: `Summarize these merged pull requests:\n${pullRequests}` },
      ],
    }),
    signal: AbortSignal.timeout(180_000),
  });
  if (!response.ok)
    throw new Error(`Anthropic answered ${response.status}: ${await response.text()}`);
  const { content } = await response.json();
  const text = content
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("")
    .trim();
  if (!text) throw new Error("Anthropic returned no text");
  return text;
}

if (process.argv[1] && import.meta.url === NodeURL.pathToFileURL(process.argv[1]).href) {
  const { values } = NodeUtil.parseArgs({
    options: {
      repository: { type: "string" },
      tag: { type: "string" },
      ref: { type: "string" },
      output: { type: "string" },
    },
  });
  const { repository, tag, ref, output } = values;
  const tags = run("gh", [
    "api",
    `repos/${repository}/git/matching-refs/tags/${TAG_PREFIX}`,
    "--paginate",
    "--jq",
    '.[].ref | ltrimstr("refs/tags/")',
  ]);
  const previous = previousTag(tags.split("\n"), tag);
  const generated = [
    "api",
    `repos/${repository}/releases/generate-notes`,
    "-f",
    `tag_name=${tag}`,
    "-f",
    `target_commitish=${ref}`,
    ...(previous ? ["-f", `previous_tag_name=${previous}`] : []),
    "--jq",
    ".body",
  ];
  const list = run("gh", generated);
  let notes = `${list}\n`;
  const apiKey = process.env["ANTHROPIC_API_KEY"];
  if (previous && apiKey) {
    try {
      notes = assembleNotes(await summarize(readPullRequests(repository, list), apiKey), list);
    } catch (error) {
      console.warn(`No summary, so the notes are GitHub's list alone: ${error.message}`);
    }
  }
  NodeFS.writeFileSync(output, notes);
}
