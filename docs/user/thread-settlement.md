# Thread settlement

Settling keeps completed work out of the active thread list without archiving or deleting it. You
can settle or un-settle a thread explicitly. New activity makes a settled thread active again.

T3 Code can also classify inactive threads as settled after a configurable number of days. This is
a derived view: crossing the inactivity threshold does not explicitly settle the thread or change
its stored lifecycle state.

The inactivity policy belongs to the environment that owns the thread. Up-to-date web, desktop,
and mobile clients connected to that environment use the same value, so switching clients does not
change which threads appear inactive. In a multi-environment list, each thread uses its owning
environment's policy. Change the primary environment's policy in **Settings → General**.
