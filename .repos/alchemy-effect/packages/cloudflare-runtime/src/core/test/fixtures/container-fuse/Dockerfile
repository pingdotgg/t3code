FROM busybox
EXPOSE 8080
# Serves the privileges a FUSE mount needs: effective capabilities and /dev/fuse.
CMD ["sh", "-c", "mkdir -p /www && { grep CapEff /proc/self/status; if [ -c /dev/fuse ]; then echo fuse-device; fi; } > /www/index.html && httpd -f -p 8080 -h /www"]
