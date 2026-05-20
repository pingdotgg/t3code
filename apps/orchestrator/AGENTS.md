# AGENTS.md

## Convex Deployment

- The orchestrator is production-backed. Treat the Convex production deployment as the canonical live deployment.
- Production site URL: `https://basic-porcupine-321.convex.site`.
- Production deployment commands must include `--prod` when inspecting or mutating live data, for example `bunx convex run --prod ...`, `bunx convex env list --prod`, and `bunx convex logs --prod`.
- Deploy orchestrator changes to production with `bunx convex deploy` from `apps/orchestrator`.
- Local production T3 callbacks must use `ORCHESTRATOR_BASE_URL=https://basic-porcupine-321.convex.site`.
- Slack, Linear, GitHub, and local T3 callbacks should point at the production Convex site URL unless the user explicitly asks to use a dev deployment.
- The old dev site `https://scrupulous-fly-947.convex.site` may still contain historical pilot data, but it is not the live target.
