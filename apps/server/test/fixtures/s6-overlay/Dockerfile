FROM alpine:3.22

ARG S6_OVERLAY_VERSION=3.2.2.0

RUN addgroup -g 10001 t3 && adduser -D -H -u 10001 -G t3 t3

ADD https://github.com/just-containers/s6-overlay/releases/download/v${S6_OVERLAY_VERSION}/s6-overlay-noarch.tar.xz /tmp/
ADD https://github.com/just-containers/s6-overlay/releases/download/v${S6_OVERLAY_VERSION}/s6-overlay-x86_64.tar.xz /tmp/

RUN tar -C / -Jxpf /tmp/s6-overlay-noarch.tar.xz \
  && tar -C / -Jxpf /tmp/s6-overlay-x86_64.tar.xz \
  && rm /tmp/s6-overlay-*.tar.xz

COPY t3-fixture /usr/local/bin/t3-fixture

RUN chmod 0755 /usr/local/bin/t3-fixture

ENTRYPOINT ["/init"]
CMD ["/bin/sh", "-c", "while :; do sleep 3600; done"]
