from util import GREETING
from workers import Response, WorkerEntrypoint


class Default(WorkerEntrypoint):
    async def fetch(self, request):
        return Response(f"{GREETING} suffix={self.env.PY_SUFFIX}")
