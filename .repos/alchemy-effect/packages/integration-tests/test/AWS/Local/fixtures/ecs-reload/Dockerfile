# Hot-reload fixture for the ECS local-dev test: busybox's built-in httpd
# serving a marker file. The test clones this directory, deploys a `context`
# Task from the clone, then rewrites index.html in the clone and asserts the
# new marker serves WITHOUT another deploy (the sidecar watch loop rebuilds,
# pushes, re-registers, and restarts the running task).
FROM busybox:stable
COPY index.html /www/index.html
CMD ["httpd", "-f", "-p", "17358", "-h", "/www"]
