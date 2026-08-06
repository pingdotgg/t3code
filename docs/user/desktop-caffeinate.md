# Caffeinate While Agents Are Running

The desktop app can keep your machine awake while an agent works, so a long turn does not stop
when the machine goes to sleep.

Turn it on in Settings > General > "Caffeinate while agents are running". The setting is off by
default and only appears in the desktop app.

## How It Works

While the toggle is on and at least one agent on this machine has a running turn, the desktop app
holds a system sleep-prevention assertion. The display can still turn off; only system sleep is
prevented. The assertion is released as soon as the last local agent settles.

Keep the app window open while agents run; minimizing it is fine. On macOS, closing the window
releases the assertion even though agents keep running in the background, so the machine can go
back to sleeping on its normal schedule.

To protect your battery, the assertion shuts off when the battery is discharging below 10%. It
comes back automatically when you plug in, when the battery charges above 10%, or when a new turn
starts under those conditions.

Agents on remote environments (SSH, relay, or another machine) do not keep this machine awake.
They keep running on their own host even if this machine sleeps.
