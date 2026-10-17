import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";

const maxAncestorDepth = 32;
const supervisingParentPollMs = 1_000;

// `vp pack --watch` starts this supervisor with `shell: true`, so the parent is
// `/bin/sh -c`, not vp. SIGKILL does not reach that shell, and ppid stays pointed
// at it. The startup ancestor chain is what still contains vp.
// oxlint-disable-next-line t3code/no-global-process-runtime -- Standalone dev script has no Effect runtime.
const hostPlatform = NodeOS.platform();

function readParentPid(pid) {
  if (hostPlatform === "linux") {
    try {
      const stat = NodeFS.readFileSync(`/proc/${pid}/stat`, "utf8");
      const marker = stat.lastIndexOf(")");
      if (marker === -1) {
        return undefined;
      }

      const ppid = Number(
        stat
          .slice(marker + 2)
          .trim()
          .split(/\s+/)[1],
      );
      return Number.isInteger(ppid) ? ppid : undefined;
    } catch (error) {
      const code =
        typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
      return code === "ENOENT" ? null : undefined;
    }
  }

  if (hostPlatform !== "darwin") {
    return null;
  }

  const result = NodeChildProcess.spawnSync("ps", ["-o", "ppid=", "-p", String(pid)], {
    encoding: "utf8",
  });
  if (typeof result.stdout !== "string" || result.status !== 0) {
    return result.status === 1 ? null : undefined;
  }

  const ppid = Number(result.stdout.trim());
  return Number.isInteger(ppid) ? ppid : undefined;
}

function readAncestors(pid) {
  const ancestors = [];
  const seen = new Set([pid]);
  let current = pid;

  while (ancestors.length < maxAncestorDepth) {
    const parent = readParentPid(current);
    if (parent === undefined) {
      return null;
    }
    if (parent === null || !Number.isInteger(parent) || parent <= 1 || seen.has(parent)) {
      break;
    }

    ancestors.push(parent);
    seen.add(parent);
    current = parent;
  }

  return ancestors;
}

export function captureSupervisingAncestors(pid = process.pid) {
  return readAncestors(pid) ?? [];
}

export function createSupervisingParentWatch(
  originalAncestors,
  onParentGone,
  intervalMs = supervisingParentPollMs,
) {
  if (originalAncestors.length === 0) {
    return {
      check() {},
      hasExited: () => false,
      stop() {},
    };
  }

  let gone = false;
  let timer = null;
  const hasExited = () => {
    if (gone) {
      return true;
    }

    const currentAncestors = readAncestors(process.pid);
    const current = currentAncestors === null ? null : new Set(currentAncestors);
    if (current === null || !originalAncestors.some((ancestor) => !current.has(ancestor))) {
      return false;
    }

    gone = true;
    return true;
  };
  const stop = () => {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };
  const check = () => {
    if (!hasExited()) {
      return;
    }

    stop();
    onParentGone();
  };

  timer = setInterval(check, intervalMs);
  timer.unref();
  return { check, hasExited, stop };
}
