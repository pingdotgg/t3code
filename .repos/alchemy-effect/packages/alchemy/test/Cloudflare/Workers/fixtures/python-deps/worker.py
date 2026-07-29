import humanize
from workers import Response, WorkerEntrypoint


class Default(WorkerEntrypoint):
    async def fetch(self, request):
        return Response(f"vendored={humanize.intcomma(1234567)}")
