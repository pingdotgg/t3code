FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends bindfs busybox && rm -rf /var/lib/apt/lists/*
COPY start.sh /start.sh
EXPOSE 8080
CMD ["sh", "/start.sh"]
