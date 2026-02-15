import { runProcess } from "../processRunner";
import { MAX_PORT_NUMBER, portFromAddress } from "./utils";

export async function collectPosixProcessFamilyPids(terminalPid: number): Promise<number[]> {
  try {
    const psResult = await runProcess("ps", ["-eo", "pid=,ppid="], {
      timeoutMs: 1_000,
      allowNonZeroExit: true,
      maxBufferBytes: 262_144,
      outputMode: "truncate",
    });
    if (psResult.code !== 0) {
      return [];
    }

    const childrenByParentPid = new Map<number, number[]>();
    for (const line of psResult.stdout.split(/\r?\n/g)) {
      const [pidRaw, ppidRaw] = line.trim().split(/\s+/g);
      const pid = Number(pidRaw);
      const ppid = Number(ppidRaw);
      if (!Number.isInteger(pid) || !Number.isInteger(ppid)) continue;
      const children = childrenByParentPid.get(ppid);
      if (children) {
        children.push(pid);
      } else {
        childrenByParentPid.set(ppid, [pid]);
      }
    }

    const processFamily = new Set<number>([terminalPid]);
    const pendingParents = [terminalPid];
    while (pendingParents.length > 0) {
      const parentPid = pendingParents.shift();
      if (!parentPid) continue;
      const childPids = childrenByParentPid.get(parentPid);
      if (!childPids || childPids.length === 0) continue;
      for (const childPid of childPids) {
        if (processFamily.has(childPid)) continue;
        processFamily.add(childPid);
        pendingParents.push(childPid);
      }
    }

    return [...processFamily];
  } catch {
    return [];
  }
}

export async function checkPosixListeningPorts(processIds: number[]): Promise<number[]> {
  if (processIds.length === 0) return [];

  const ports = new Set<number>();
  const pidFilter = new Set(processIds);

  try {
    const result = await runProcess(
      "lsof",
      ["-nP", "-a", "-iTCP", "-sTCP:LISTEN", "-p", processIds.join(",")],
      {
        timeoutMs: 1_500,
        allowNonZeroExit: true,
        maxBufferBytes: 262_144,
        outputMode: "truncate",
      },
    );
    if (result.code !== 0) {
      // `lsof` returns 1 when there are no matching files/sockets.
      // This is a valid "no results" outcome; avoid falling back to `ss`.
      return [];
    }

    for (const line of result.stdout.split(/\r?\n/g)) {
      const match = line.match(/:(\d+)\s+\(LISTEN\)$/);
      if (!match?.[1]) continue;
      const port = Number(match[1]);
      if (Number.isInteger(port) && port > 0 && port <= MAX_PORT_NUMBER) {
        ports.add(port);
      }
    }
    return [...ports].toSorted((left, right) => left - right);
  } catch {
    // Fall back to ss if lsof is unavailable.
  }

  try {
    const result = await runProcess("ss", ["-ltnp"], {
      timeoutMs: 1_500,
      allowNonZeroExit: true,
      maxBufferBytes: 524_288,
      outputMode: "truncate",
    });
    if (result.code !== 0) {
      return [];
    }

    for (const line of result.stdout.split(/\r?\n/g)) {
      if (!line.includes("pid=")) continue;
      const localAddress = line.trim().split(/\s+/g)[3];
      if (!localAddress) continue;
      const port = portFromAddress(localAddress);
      if (port === null) continue;

      const pidMatches = [...line.matchAll(/pid=(\d+)/g)];
      if (pidMatches.length === 0) continue;
      if (
        pidMatches.some((match) => {
          const pid = Number(match[1]);
          return Number.isInteger(pid) && pidFilter.has(pid);
        })
      ) {
        ports.add(port);
      }
    }
    return [...ports].toSorted((left, right) => left - right);
  } catch {
    return [];
  }
}
