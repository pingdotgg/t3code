import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

// oxlint-disable-next-line t3code/no-global-process-runtime -- Standalone dev script has no Effect runtime.
const hostPlatform = NodeOS.platform();

function readAncestors() {
  if (hostPlatform !== "linux" && hostPlatform !== "darwin") {
    return [];
  }

  let parents;
  if (hostPlatform === "darwin") {
    // Read the whole chain in one bounded ps call, rather than spawning per ancestor.
    const result = NodeChildProcess.spawnSync("ps", ["-axo", "pid=,ppid=,comm="], {
      encoding: "utf8",
      timeout: 1_000,
      killSignal: "SIGKILL",
      maxBuffer: 1024 * 1024,
    });
    if (result.error || result.status !== 0) {
      return null;
    }
    parents = new Map(
      result.stdout
        .trim()
        .split("\n")
        .map((line) => {
          const [, pid, parent, command] = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/) ?? [];
          return [Number(pid), { parent: Number(parent), command }];
        }),
    );
  }

  const ancestors = [];
  let pid = process.pid;
  while (ancestors.length < 2) {
    let parent;
    let command;
    if (parents) {
      ({ parent, command } = parents.get(pid) ?? {});
    } else {
      try {
        const stat = NodeFS.readFileSync(`/proc/${pid}/stat`, "utf8");
        parent = Number(stat.slice(stat.lastIndexOf(")") + 2).split(/\s+/)[1]);
        command = stat.slice(stat.indexOf("(") + 1, stat.lastIndexOf(")"));
      } catch {
        return null;
      }
    }
    if (!Number.isInteger(parent)) {
      return null;
    }
    // Only an intermediate shell makes its parent part of our launch ownership.
    if (ancestors.length === 1 && !/^(sh|bash|dash|zsh|ksh)$/.test(NodePath.basename(command))) {
      break;
    }
    if (parent <= 1 || ancestors.includes(parent)) {
      break;
    }
    ancestors.push(parent);
    pid = parent;
  }
  return ancestors;
}

export function watchSupervisingAncestors(onParentGone) {
  // vp starts us through a shell that can survive its launcher being killed.
  const originalAncestors = readAncestors();
  const check = () => {
    if (!originalAncestors?.length) {
      return false;
    }
    const currentAncestors = readAncestors();
    if (currentAncestors && originalAncestors.some((pid) => !currentAncestors.includes(pid))) {
      onParentGone();
      return true;
    }
    return false;
  };
  const timer = originalAncestors?.length ? setInterval(check, 1_000) : undefined;
  timer?.unref();
  return { check, stop: () => clearInterval(timer) };
}
