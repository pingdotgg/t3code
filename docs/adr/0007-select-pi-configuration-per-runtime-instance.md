# Select Pi configuration per runtime instance

Each Pi runtime instance may optionally specify a Pi configuration directory. T3 Code passes it as `PI_AGENT_DIR`; when absent, Pi uses the user's normal configuration. Pi session storage stays separately isolated by T3 Code provider instance, so choosing a configuration home does not merge session histories.
