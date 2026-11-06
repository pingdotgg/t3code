FROM alpine:3.21

ARG GREETING
# Record what the build saw: the build arg verbatim, and the secret's length
# rather than its value, so the file proves the mount without leaking it.
RUN --mount=type=secret,id=token,required=true \
  echo "$GREETING $(wc -c < /run/secrets/token)" > /build.txt
