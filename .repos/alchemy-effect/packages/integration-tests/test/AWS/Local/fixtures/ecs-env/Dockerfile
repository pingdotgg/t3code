# Prop-roll fixture for the ECS local-dev test: busybox writes the ROLL_ENV
# task-definition env var to /www/env.txt at startup and serves it. The test
# redeploys with a different env value — a pure prop change, no file event —
# and asserts the running container rolls onto the new revision.
FROM busybox:stable
CMD ["sh", "-c", "mkdir -p /www && echo -n \"$ROLL_ENV\" > /www/env.txt && exec httpd -f -p 17361 -h /www"]
