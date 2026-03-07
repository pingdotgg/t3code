# Runtime modes

T3 Code has a global runtime mode switch in the chat toolbar:

- **Full access** (default): starts sessions with `approvalPolicy: never` and `sandboxMode: danger-full-access`.
- **Supervised**: starts sessions with `approvalPolicy: on-request` and `sandboxMode: workspace-write`, then prompts in-app for command/file approvals.
