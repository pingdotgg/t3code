# A Goal forces default interaction mode

T3’s plan mode is for proposing, not mutating. Auto-continue in plan mode would keep planning and rarely Complete a code-change Objective. Refusing `/goal` until `/default` adds a step the user already contradicted by asking to keep working until done.

We decided that setting or resuming a Goal sets interaction mode to `default`. A Goal does not run in plan mode.
