FROM public.ecr.aws/lambda/microvms:al2023-minimal

RUN dnf install -y python3 && dnf clean all

WORKDIR /app
COPY app.py .

EXPOSE 8080
CMD ["python3", "app.py"]
