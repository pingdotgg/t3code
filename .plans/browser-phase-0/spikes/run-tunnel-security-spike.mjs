import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const requireDesktop = createRequire(join(repositoryRoot, "apps/desktop/package.json"));
const electronBinary = requireDesktop("electron");

function listen(server) {
  return new Promise((resolvePort, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolvePort(server.address().port));
  });
}

function close(server) {
  return new Promise((resolveClose, reject) =>
    server.close((error) => (error ? reject(error) : resolveClose())),
  );
}

const observed = [];
const previewHandler = (request, response) => {
  observed.push({ url: request.url, origin: request.headers.origin ?? null });
  if (request.url === "/absolute-redirect") {
    response.writeHead(302, { location: "https://remote.example.test/callback" });
    response.end();
    return;
  }
  response.writeHead(200, { "content-type": "text/html" });
  response.end("<!doctype html><title>Preview target</title><h1>preview target</h1>");
};
const previewA = createServer(previewHandler);
const previewB = createServer(previewHandler);
const malicious = createServer((_request, response) => {
  response.writeHead(200, { "content-type": "text/html" });
  response.end("<!doctype html><title>Untrusted page</title><h1>untrusted page</h1>");
});

const [previewAPort, previewBPort, maliciousPort] = await Promise.all([
  listen(previewA),
  listen(previewB),
  listen(malicious),
]);
const previewAUrl = `http://127.0.0.1:${previewAPort}`;
const previewBUrl = `http://127.0.0.1:${previewBPort}`;
const maliciousUrl = `http://127.0.0.1:${maliciousPort}`;

const childEnvironment = { ...process.env };
delete childEnvironment.ELECTRON_RUN_AS_NODE;
const child = spawn(
  electronBinary,
  [join(import.meta.dirname, "tunnel-security-electron.cjs"), maliciousUrl, previewAUrl, previewBUrl],
  { cwd: repositoryRoot, env: childEnvironment, stdio: ["ignore", "pipe", "pipe"] },
);
let stdout = "";
let stderr = "";
child.stdout.on("data", (bytes) => {
  stdout += bytes;
});
child.stderr.on("data", (bytes) => {
  stderr += bytes;
});
const exitCode = await new Promise((resolveExit) => child.once("exit", resolveExit));

try {
  const resultLine = stdout
    .split("\n")
    .find((line) => line.startsWith("PHASE05_TUNNEL "));
  if (!resultLine) throw new Error(`Electron probe did not emit a result: ${stderr || stdout}`);
  const browserResult = JSON.parse(resultLine.slice("PHASE05_TUNNEL ".length));
  const redirectResponse = await fetch(`${previewAUrl}/absolute-redirect`, { redirect: "manual" });
  process.stdout.write(
    `${JSON.stringify(
      {
        success: exitCode === 0,
        browserResult,
        untrustedPageCausedLoopbackRequest: observed.some((request) => request.url === "/secret"),
        loopbackRequestOriginHeader: observed.find((request) => request.url === "/secret")?.origin ?? null,
        observed,
        originStickiness: {
          sameAuthorityPreservedStorage: browserResult.originalPortValue === "sticky",
          differentPortChangedOrigin: browserResult.otherPortValue === null,
        },
        absoluteRedirect: {
          status: redirectResponse.status,
          location: redirectResponse.headers.get("location"),
          escapedLoopbackAuthority: redirectResponse.headers.get("location")?.startsWith("https://") ?? false,
        },
      },
      null,
      2,
    )}\n`,
  );
} finally {
  await Promise.all([close(previewA), close(previewB), close(malicious)]);
}
