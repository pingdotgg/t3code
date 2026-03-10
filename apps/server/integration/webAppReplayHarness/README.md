# webAppReplayHarness (app adapter)

This directory intentionally keeps only app-specific adapter logic.

Core record/replay primitives live in `@t3tools/rr-e2e` (`packages/rr-e2e`), while this adapter wires those primitives into T3 server services (Codex manager, Git/GH services, and runtime layer composition).
