# Blocked is a first-class Goal state

Auto-continue without a stuck state will burn tokens on empty Continuations, repeated test failures, and approval impasses. Treating that as Pause would lie: Pause means the user stopped the Goal.

We decided Blocked is its own state. The model may enter it only via a structured signal, the same rule as Complete. T3 may also enter it when Continuations produce no progress (no tool use or checkpoint diff). Resume tries again. Chat prose cannot Block.
