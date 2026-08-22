# runtime decision

use the effect-scope runtime with the deterministic pure planner.

- effect already powers t3 and gives each plugin owned async resources and reliable cleanup.
- the pure planner keeps validation, targeted restarts, atomic publication, and rollback predictable.
- pure-only requires manual lifetime management. cordis duplicates effect's lifecycle system and still needs the same t3-specific planner.
