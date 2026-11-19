# Custom agent boundaries

Named custom agents choose instructions and, when configured, a model or economy/reasoning tier when a T3 thread starts. A model picked explicitly in the composer takes precedence. The selected agent stays attached to that thread; this feature does not route later tasks by inferred complexity or switch models mid-run.

`canDelegateTo` is enforced for named targets passed through T3's `delegate_task` tool. It does not govern provider-native subagent tools, whose calls bypass T3's delegation command. Agent `tools` frontmatter is unsupported and does not restrict provider capabilities.

Automatic lead-agent routing is a separate design. An opt-in lead could receive the initial request and choose from an explicit allowlist of lightweight and deep agents using a documented complexity rubric. T3 would persist the chosen agent and resolved model before the first provider turn, honor a user's explicit agent or model choice, and report when no allowed target is available. That design needs a labeled routing evaluation and clear latency and cost limits before implementation.
