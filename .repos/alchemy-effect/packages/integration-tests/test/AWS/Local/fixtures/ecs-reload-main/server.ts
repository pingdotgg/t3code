/**
 * External-`main` hot-reload fixture for the ECS local-dev test: a plain
 * Bun HTTP server (no Effect entry — the Task is declared without an inline
 * impl, so the bundle runs as-is). The test clones this file, deploys a
 * bundled-`main` Task from the clone, then rewrites the marker below and
 * asserts the new marker serves WITHOUT another deploy.
 */
const server = Bun.serve({
  port: Number(process.env.PORT ?? 17360),
  fetch: () => new Response("ecs-reload-main-v1"),
});

console.log(`ecs-reload-main fixture listening on ${server.port}`);
