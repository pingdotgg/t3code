import * as Alchemy from "alchemy";
import * as Hetzner from "alchemy/Hetzner";
import * as Neon from "alchemy/Neon";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import Api from "./src/api.ts";
import { Box, NeonBranch, NeonProject } from "./src/shared.ts";

export default Alchemy.Stack(
  "HetznerWebsiteViteExample",
  {
    providers: Layer.mergeAll(Hetzner.providers(), Neon.providers()),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const server = yield* Box;
    const project = yield* NeonProject;
    const branch = yield* NeonBranch;
    const api = yield* Api;
    const web = yield* Hetzner.Website.Vite("Web", {
      server,
      env: {
        VITE_API_URL: Output.map(api.url, (url) => url ?? ""),
      },
      memo: {
        include: ["index.html", "src/**", "package.json", "vite.config.ts"],
      },
    });

    return {
      url: web.url,
      apiUrl: api.url,
      serverId: server.serverId,
      ipv4: server.ipv4,
      neonProjectId: project.projectId,
      neonBranchId: branch.branchId,
    };
  }),
);
