import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

function removeOwner(lockDir, owner) {
  const pause = new Int32Array(new SharedArrayBuffer(4));
  for (let attempt = 0; ; attempt++) {
    try {
      NodeFS.unlinkSync(NodePath.join(lockDir, owner));
      break;
    } catch (error) {
      if (error.code === "ENOENT") break;
      if (!["EPERM", "EBUSY"].includes(error.code) || attempt === 3) throw error;
      Atomics.wait(pause, 0, 0, 100);
    }
  }
  removeEmptyLock(lockDir);
}

function removeEmptyLock(lockDir) {
  try {
    NodeFS.rmdirSync(lockDir);
  } catch (error) {
    if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(error.code)) throw error;
  }
}

function reapDeadOwner(lockDir) {
  let entries;
  try {
    entries = NodeFS.readdirSync(lockDir);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  if (entries.length === 0) removeEmptyLock(lockDir);
  for (const owner of entries) {
    const match = /^owner-(\d+)-/.exec(owner);
    let pid;
    if (match) {
      pid = Number(match[1]);
    } else if (owner === "pid") {
      try {
        pid = Number(NodeFS.readFileSync(NodePath.join(lockDir, owner), "utf8"));
      } catch (error) {
        if (error.code === "ENOENT") continue;
        throw error;
      }
    }
    if (!Number.isSafeInteger(pid) || pid <= 0) {
      throw new Error(`Invalid Electron runtime lock owner: ${owner}`);
    }
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error.code === "ESRCH") removeOwner(lockDir, owner);
      else if (error.code !== "EPERM") throw error;
    }
  }
}

export function withPublishLock(electronDir, fn) {
  const lockDir = NodePath.join(electronDir, ".t3-publish.lock");
  const stage = NodeFS.mkdtempSync(NodePath.join(electronDir, `.t3-lock-${process.pid}-`));
  const owner = `owner-${process.pid}-${NodeCrypto.randomUUID()}`;
  const pause = new Int32Array(new SharedArrayBuffer(4));
  try {
    NodeFS.writeFileSync(NodePath.join(stage, owner), "");
    for (;;) {
      try {
        // Publish a non-empty claim atomically; a fresh owner's directory is never removable.
        NodeFS.renameSync(stage, lockDir);
        break;
      } catch (error) {
        if (!["EEXIST", "ENOTEMPTY", "EPERM"].includes(error.code)) throw error;
        reapDeadOwner(lockDir);
        Atomics.wait(pause, 0, 0, 100);
      }
    }
    try {
      return fn();
    } finally {
      // Unique claims and non-recursive rmdir cannot evict a replacement owner.
      removeOwner(lockDir, owner);
    }
  } finally {
    NodeFS.rmSync(stage, { recursive: true, force: true });
  }
}
