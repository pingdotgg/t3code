# Tiny HTTP fixture for the ECS local-dev conformance test: busybox's
# built-in httpd serving a marker file. The COPY proves the docker build
# actually ran over this context (the marker travels from the checked-in
# context into the image layer).
FROM busybox:stable
COPY index.html /www/index.html
CMD ["httpd", "-f", "-p", "17356", "-h", "/www"]
