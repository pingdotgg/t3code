# Refactor Orchestrator schema around Tasks

The current `apps/orchestrator` schema was built as a Linear MVP bridge around `controlThreads` and `executionRuns`, but the AI Engineer product model is centered on Tasks. We decided to refactor the Orchestrator schema around `tasks` as the current state record, with lean child records for Task-thread associations, External Links, Work Sessions, and important Task events; this keeps Convex documents small and queryable without turning the app into a fully event-sourced system.
