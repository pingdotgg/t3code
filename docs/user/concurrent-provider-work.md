# Concurrent provider work

T3 allows at most eight top-level provider turns at once. Ready sessions do not count. Admission reserves a slot before provider startup and releases it when startup fails or the admitted turn or compaction finishes; provider-owned subagents are outside this limit. Handover generation can share these reservations when enabled.
