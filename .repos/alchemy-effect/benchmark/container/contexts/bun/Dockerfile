# Same base image as the effectful container (`oven/bun:latest`), but with NO
# Effect program bundled in — just a one-line Bun HTTP server. This isolates
# the Effect-runtime/bundle cost from the base-image pull/boot cost: any
# time-to-usable-service gap between this and the effectful variant is
# attributable to the bundled Effect runtime, not the image.
FROM oven/bun:latest

RUN printf 'Bun.serve({ port: 8080, hostname: "0.0.0.0", fetch: () => new Response("ok") });\n' > /server.ts

EXPOSE 8080
CMD ["bun", "/server.ts"]
