# Context-built one-shot task image: the `context:` image source builds this
# Dockerfile with your local Docker and pushes it into the task's generated
# ECR repository (`dockerfile:` may point at an alternative path; it defaults
# to `${context}/Dockerfile`).
FROM public.ecr.aws/docker/library/busybox:stable

CMD ["sh", "-c", "echo orders report generated at $(date -u)"]
