# Skills

Open **Skills** from the sidebar or command palette to inspect skills reported by your configured
provider instances. Choose an **Environment**, then a **Project** to include that workspace's skills.
**Environment skills** shows each provider's environment-level inventory. Remote connections show
skills on the selected server, not on the device displaying the page.

Filter by provider instance, enabled status, invocation policy, or scope. Disabled skills remain
visible. Invocation policy describes whether the user, the agent, both, or neither can invoke the
skill when enabled; a disabled provider instance cannot run it. Discovery and policy information
come from the provider, so availability depends on what that provider reports.

Installations pointing to the same resolved file share one entry. Select it to inspect the
instructions and each provider instance's skill name, status, installation path, and resolved
destination. Different files with the same name remain separate entries.

The page is read-only. Install or change skills through their provider, then use **Refresh** to
reload discovery. Skills are not automatically copied or synchronized between environments.
