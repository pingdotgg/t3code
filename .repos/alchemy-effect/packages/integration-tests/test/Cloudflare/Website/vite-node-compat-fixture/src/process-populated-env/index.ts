import assert from "node:assert";

export default {
  async fetch() {
    return testProcessBehaviour();
  },
} satisfies ExportedHandler;

function testProcessBehaviour() {
  try {
    // eslint-disable-next-line turbo/no-undeclared-env-vars -- Worker runtime code: populated via Worker bindings, not a Node.js process env var
    assert(process.env.FOO === "foo value", "process.env.FOO not populated");
    // eslint-disable-next-line turbo/no-undeclared-env-vars -- Worker runtime code: populated via Worker bindings, not a Node.js process env var
    assert(process.env.BAR === "bar secret", "process.env.BAR not populated");

    const processEnvKeys = Object.keys(process.env).sort();

    // Alchemy binds its runtime variables to every Worker.
    assert.deepStrictEqual(processEnvKeys, [
      "ALCHEMY_CLOUDFLARE_ACCOUNT_ID",
      "ALCHEMY_PHASE",
      "ALCHEMY_STACK_NAME",
      "ALCHEMY_STAGE",
      "ALCHEMY_WORKER_NAME",
      "BAR",
      "FOO",
    ]);
  } catch (e) {
    if (e instanceof Error) {
      return new Response(`${e.stack}`, { status: 500 });
    } else {
      throw e;
    }
  }

  return new Response("OK!");
}
