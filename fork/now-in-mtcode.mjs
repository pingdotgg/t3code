// Git sequence editor for the pipeline's rebase: turns `pick` into `drop` for each fork commit
// listed in now-in-mtcode.txt whose upstream commit is already in the new MT Code release.
// Usage: GIT_SEQUENCE_EDITOR="node now-in-mtcode.mjs <list file> <new release ref>" git rebase -i ...
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";

const [listPath, releaseRef, todoPath] = process.argv.slice(2);
if (!listPath || !releaseRef || !todoPath) {
  console.error("usage: now-in-mtcode.mjs <list file> <new release ref> <rebase todo file>");
  process.exit(2);
}

const entries = NodeFS.readFileSync(listPath, "utf8")
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter((line) => line.length > 0 && !line.startsWith("#"))
  .map((line) => {
    const match = /^([0-9a-f]{7,40})\s+(.+)$/.exec(line);
    if (!match) {
      console.error(`now-in-mtcode.txt: bad line: ${line}`);
      process.exit(1);
    }
    return { upstream: match[1], subject: match[2] };
  });

const inRelease = (sha) => {
  try {
    NodeChildProcess.execFileSync("git", ["merge-base", "--is-ancestor", sha, releaseRef], {
      stdio: "ignore",
    });
    return true;
  } catch {
    // Exit 1 means not an ancestor; 128 means the commit isn't known yet. Both mean "not yet".
    return false;
  }
};

const droppable = new Map(
  entries.filter((entry) => inRelease(entry.upstream)).map((entry) => [entry.subject, entry]),
);

const todo = NodeFS.readFileSync(todoPath, "utf8").split("\n");
const edited = todo.map((line) => {
  const match = /^(?:p|pick) ([0-9a-f]+) (# )?(.*)$/.exec(line);
  const entry = match && droppable.get(match[3]);
  if (!entry) return line;
  console.log(`Leaving out "${match[3]}": ${releaseRef} already has ${entry.upstream}`);
  return `drop ${match[1]} ${match[2] ?? ""}${match[3]}`;
});
NodeFS.writeFileSync(todoPath, edited.join("\n"));
