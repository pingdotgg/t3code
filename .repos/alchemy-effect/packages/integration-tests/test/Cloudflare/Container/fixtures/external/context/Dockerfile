FROM nginxinc/nginx-unprivileged:alpine

# The stock nginx image symlinks /var/log/nginx/{access,error}.log to
# /dev/stdout and /dev/stderr. Inside Cloudflare's container sandbox those
# device paths cannot be opened (open() fails with ENXIO, errno 6), so nginx
# aborts at startup with `[emerg] could not open error log file` and the
# container crash-loops — the port is never bound and getTcpPort() hangs.
# Replace the symlinks with real, nginx-writable files so the master can boot.
USER root
RUN rm -f /var/log/nginx/access.log /var/log/nginx/error.log \
  && touch /var/log/nginx/access.log /var/log/nginx/error.log \
  && chown nginx:nginx /var/log/nginx/access.log /var/log/nginx/error.log
USER nginx

COPY index.html /usr/share/nginx/html/index.html
EXPOSE 8080
