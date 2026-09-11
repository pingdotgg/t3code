import { createFileRoute } from "@tanstack/react-router";
import { checkDatabaseReady } from "../../prisma/queries";

export const Route = createFileRoute("/api/health")({
  server: {
    handlers: {
      GET: async () => {
        await checkDatabaseReady();
        const configurationReady =
          process.env.TANSTACK_SHARED_FLAG === "project-level";
        return Response.json(
          {
            ok: configurationReady,
            database: "ready",
            configuration: configurationReady ? "ready" : "unavailable",
          },
          { status: configurationReady ? 200 : 503 },
        );
      },
    },
  },
});
