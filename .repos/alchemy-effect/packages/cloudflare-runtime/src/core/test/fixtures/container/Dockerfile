FROM busybox
RUN mkdir -p /www
EXPOSE 8080
CMD ["sh", "-c", "echo \"hello from container${CONTAINER_GREETING:+ }${CONTAINER_GREETING}\" > /www/index.html && httpd -f -p 8080 -h /www"]
