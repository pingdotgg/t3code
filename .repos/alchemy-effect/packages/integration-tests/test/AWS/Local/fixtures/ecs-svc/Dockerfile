# Image-owning ECS Service fixture for the local-dev test: busybox's httpd
# serving a marker file. The Service synthesizes its own task definition
# from this context, the floci scheduler launches the task as a real
# container, and the test drives hot reload by rewriting index.html in a
# clone of this directory.
FROM busybox:stable
COPY index.html /www/index.html
CMD ["httpd", "-f", "-p", "17359", "-h", "/www"]
