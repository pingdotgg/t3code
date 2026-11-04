-- Empty installer authentication probes are not task execution history.
DELETE FROM savings
WHERE local_hits = 0 AND remote_hits = 0 AND unspecified_hits = 0
  AND executed = 0 AND restore_failures = 0;
