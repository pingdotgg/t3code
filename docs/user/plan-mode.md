# Plan Mode

Enable **Plan Mode (Legacy)** in **Settings → General → Legacy features** on web and desktop, or
in the **Legacy** section of Settings on mobile. The preference follows the connected environment,
so web, desktop, and mobile clients using that environment converge on the same setting.

Changes made while a client is offline remain available on that device. T3 Code reconciles the
newest saved choice when the environment reconnects. If several environments are connected on
mobile, the most recently updated choice is applied across them.

When enabled, the composer can send turns in either **Build** or **Plan** mode. Build is the normal
mode: the agent can inspect and change the project. Plan asks the agent to develop a plan before
implementation. Use `/plan` to switch the current composer to Plan and `/default` to switch back to
Build. Submitting either command by itself changes the mode without sending a message.

When Plan Mode (Legacy) is disabled, those two slash commands are hidden and every new or queued
turn is sent in Build mode. This also applies to drafts created while the setting was still loading,
so an old saved Plan selection cannot bypass the current setting.
