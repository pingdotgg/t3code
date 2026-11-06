// Usage: node cdp.mjs <port> '<js expression>'  -> prints JSON result from the first page target.
const [port, expr] = process.argv.slice(2);
const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = targets.find((t) => t.type === "page" && !t.url.startsWith("devtools"));
if (!page) { console.log(JSON.stringify(targets.map(t=>[t.type,t.url]))); process.exit(1); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r));
ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression: expr, awaitPromise: true, returnByValue: true } }));
ws.addEventListener("message", (m) => {
  const msg = JSON.parse(m.data);
  if (msg.id === 1) { console.log(JSON.stringify(msg.result.result?.value ?? msg.result, null, 1)); ws.close(); process.exit(0); }
});
