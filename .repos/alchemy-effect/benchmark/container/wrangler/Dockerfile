# Same base image as the Alchemy "bun-baseline" benchmark variant
# (`oven/bun:latest`) running a one-line Bun HTTP server on port 8080. Keeping
# the image identical makes the wrangler numbers directly comparable to the
# Alchemy ones — any difference is attributable to the framework, not the
# image.
FROM oven/bun:latest

RUN printf 'Bun.serve({ port: 8080, hostname: "0.0.0.0", fetch: () => new Response("ok") });\n' > /server.ts

EXPOSE 8080
CMD ["bun", "/server.ts"]
