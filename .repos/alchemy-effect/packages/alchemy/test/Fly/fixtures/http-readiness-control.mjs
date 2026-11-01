import { existsSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";

const machineId = process.env.FLY_MACHINE_ID;
const token = process.env[process.env.READINESS_CONTROL_SECRET];
if (!machineId || !token) throw new Error("Missing readiness control identity");

writeFileSync("/tmp/ready", "ready");
http
  .createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    response.setHeader("cache-control", "no-store");
    if (request.method === "GET" && request.url === "/ready") {
      const ready = existsSync("/tmp/ready");
      response.writeHead(ready ? 200 : 503);
      response.end(JSON.stringify({ machineId, ready }));
      return;
    }
    if (request.method === "POST" && request.url === "/readiness/off") {
      if (request.headers.authorization !== `Bearer ${token}`) {
        response.writeHead(401).end();
        return;
      }
      if (request.headers["x-readiness-machine-id"] !== machineId) {
        response.writeHead(409).end();
        return;
      }
      try {
        rmSync("/tmp/ready", { force: true });
        response.end(JSON.stringify({ machineId, ready: false }));
      } catch {
        response.writeHead(500).end();
      }
      return;
    }
    response.writeHead(404).end();
  })
  .listen(3000, "::");
