# One Goal per Thread, set replaces

A Goal is the Thread’s current completion contract, not a queue. Stacking would need scheduling UI we do not have. Rejecting a second `/goal` would block the usual “do this instead.”

We decided a Thread has at most one Goal. `/goal` with a new Objective replaces it. If a Turn is already running, T3 does not steal it; when that Turn ends, Continuations follow the new Objective. Stop pauses the Goal that is current after the replace.
