# The ECS half of the dev-stress stack. The stress suite edits this file IN
# PLACE while `alchemy dev` runs (the BAKED_MARKER line), edits index.html
# next to it, and changes the service's env prop — three different ways a
# "docker file" changes, each of which must hot-reload the running task.
FROM busybox:stable
COPY index.html /www/index.html
ENV BAKED_MARKER=dockerfile-v1
# Write the baked marker AND the runtime env marker at startup, then serve.
# /baked.txt proves an image rebuild landed; /env.txt proves a task restart
# picked up new task-definition env (no rebuild involved).
CMD ["sh", "-c", "echo -n \"$BAKED_MARKER\" > /www/baked.txt && echo -n \"$STRESS_ENV\" > /www/env.txt && exec httpd -f -p 8796 -h /www"]
