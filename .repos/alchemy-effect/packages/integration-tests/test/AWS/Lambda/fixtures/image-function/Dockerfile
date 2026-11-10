FROM public.ecr.aws/lambda/nodejs:22

COPY index.mjs marker.txt ${LAMBDA_TASK_ROOT}/

CMD ["index.handler"]
