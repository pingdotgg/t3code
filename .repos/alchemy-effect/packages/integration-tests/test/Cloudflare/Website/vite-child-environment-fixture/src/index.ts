// Mirrors `@cloudflare/vite-plugin`'s `playground/child-environment`.
declare global {
  // In real world usage, this is accessed by `@vitejs/plugin-rsc`
  function __VITE_ENVIRONMENT_RUNNER_IMPORT__(
    environmentName: string,
    id: string,
  ): Promise<unknown>;
}

export default {
  async fetch(request) {
    const childEnvironmentEntry = "./child/child-environment-module.js";
    const childEnvironmentModule = (await (typeof __VITE_ENVIRONMENT_RUNNER_IMPORT__ === "function"
      ? __VITE_ENVIRONMENT_RUNNER_IMPORT__("child", "./src/child-environment-module")
      : import(/* @vite-ignore */ childEnvironmentEntry))) as {
      additionalModule: string;
      getMessage: () => string;
    };

    return new Response(
      new URL(request.url).pathname === "/additional-module"
        ? childEnvironmentModule.additionalModule
        : childEnvironmentModule.getMessage(),
    );
  },
} satisfies ExportedHandler;
