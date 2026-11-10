import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/db")({
  server: {
    handlers: {
      GET: async () => {
        const { fetchSql } = await import("../db");
        const result = await fetchSql();
        return Response.json(result);
      },
    },
  },
});
