# Minimal SageMaker inference container for the Floci fixtures. SageMaker (and
# Floci) start the image with the argument `serve` and probe port 8080, so the
# script is on PATH and there is deliberately no ENTRYPOINT.
FROM python:3.12-alpine
COPY serve /usr/local/bin/serve
RUN chmod 0755 /usr/local/bin/serve
EXPOSE 8080
CMD ["serve"]
