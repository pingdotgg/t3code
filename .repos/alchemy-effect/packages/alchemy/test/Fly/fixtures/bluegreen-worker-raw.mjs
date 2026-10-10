import http from "node:http";

const machine = process.env.FLY_MACHINE_ID;
const version = process.env.VERSION;
const mode = process.env.MODE || "drain";
const afterSignal = Number(process.env.AFTER_SIGNAL_MS || "1000");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const call = async (operation, args = []) => {
  const response = await fetch(process.env.LEDGER_URL, {
    method: "POST",
    headers: {
      authorization: `Bearer ${process.env.LEDGER_TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ operation, args }),
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error(`ledger HTTP ${response.status}`);
  return (await response.json()).result;
};
const event = (name, fields = {}) =>
  call("event", [JSON.stringify({ event: name, machine, version, ...fields })]);
let resolveStop;
const stopping = new Promise((resolve) => {
  resolveStop = resolve;
});
const jobs = new Set();
let workerClientOpen = true;
const workerCall = (operation, args) => {
  if (!workerClientOpen)
    throw new Error("worker queue client already released");
  return call(operation, args);
};
const requestFinalizers = [];
let accepting = true;
let poll;
let started = false;
const server = http.createServer(async (request, response) => {
  try {
    if (request.url === "/health") return response.end("ready");
    if (request.url === "/")
      return response.end(JSON.stringify({ machine, version }));
    await event("request-started");
    response.once("finish", () =>
      requestFinalizers.push(event("request-finalized")),
    );
    if (request.url === "/stream") response.write("first\n".repeat(32768));
    await stopping;
    await sleep(afterSignal);
    await event("response-finished");
    response.end(
      request.url === "/stream"
        ? "last\n".repeat(32768)
        : JSON.stringify({ machine, version }),
    );
  } catch (error) {
    console.error(error);
    response.destroy();
  }
});
const processJob = async (job) => {
  if (!job.checkpoint && job.kind !== "quick") {
    await stopping;
    if (job.kind === "checkpoint") {
      await workerCall("checkpoint", [job.id, job.job, machine]);
      return;
    }
    await sleep(afterSignal);
  } else await sleep(100);
  await workerCall("finish", [job.id, job.job, machine]);
};
const acquire = async () => {
  if (!accepting) return;
  await workerCall("tick", [machine, version]);
  const result = await workerCall("claim", [machine, version]);
  if (!result) return;
  const job = JSON.parse(result);
  const running = processJob(job)
    .catch(async (error) => {
      process.exitCode = 1;
      console.error(error);
      await workerCall("checkpoint", [job.id, job.job, machine]);
    })
    .finally(() => {
      jobs.delete(running);
    });
  jobs.add(running);
};
const timer = setInterval(() => {
  if (poll || !accepting) return;
  poll = acquire()
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    })
    .finally(() => {
      poll = undefined;
    });
}, 250);
const shutdown = async (signal) => {
  if (started) return;
  started = true;
  setTimeout(
    () => process.exit(1),
    Number(process.env.SHUTDOWN_MS || "30000") * 0.9,
  );
  const httpClosed = new Promise((resolve) => server.close(resolve));
  await event("stop-started", { worker: "a", signal });
  if (mode === "stop-delay") await sleep(1000);
  accepting = false;
  clearInterval(timer);
  await poll;
  await event("stopped", { worker: "a" });
  resolveStop();
  await Promise.all([...jobs]);
  await event("drained", { worker: "a" });
  await event("work-closed", { worker: "a" });
  await event("client-released", { worker: "a" });
  workerClientOpen = false;
  await httpClosed;
  await Promise.all(requestFinalizers);
  await event("shared-closed");
  process.exit(process.exitCode || 0);
};
for (const signal of ["SIGTERM", "SIGINT", "SIGQUIT"])
  process.on(signal, () => {
    void shutdown(signal).catch((error) => {
      console.error(error);
      process.exit(1);
    });
  });
await event("worker-ready", { worker: "a" });
server.listen(3000, "::");
