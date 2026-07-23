# Bind Pi thread continuation to its runtime instance

A Pi thread may continue only through its originating Pi runtime instance. The runtime instance defines the Pi configuration environment, extensions, credentials, model catalog, and isolated session directory required to interpret and safely resume its native Pi session. Provider-session routing rejects same-driver starts with a persisted resume cursor whose continuation identities differ, so this rule is enforced below the user-facing orchestration path as well.
