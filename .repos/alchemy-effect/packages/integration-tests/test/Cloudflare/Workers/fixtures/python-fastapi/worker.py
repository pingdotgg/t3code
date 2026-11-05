# Exercises the supported-package surface of Cloudflare Python Workers:
# - fastapi served through the runtime-provided `asgi` module
# - pydantic request validation (ships with fastapi)
# - numpy: a compiled-extension wheel, proving the emscripten-wasm32 ABI
#   of vendored binary wheels matches the deployed Pyodide runtime
# - httpx: async outbound HTTP (sync clients are unsupported on Workers)
# - env bindings threaded into ASGI routes via request.scope["env"]
import asgi
import httpx
import numpy as np
from fastapi import FastAPI, Request
from pydantic import BaseModel
from workers import WorkerEntrypoint

app = FastAPI()


class Item(BaseModel):
    name: str
    quantity: int


@app.get("/")
async def root():
    return {"framework": "fastapi"}


@app.get("/env")
async def env(request: Request):
    return {"deployment": request.scope["env"].DEPLOYMENT}


@app.post("/items")
async def create_item(item: Item):
    return {"name": item.name, "total": item.quantity * 2}


@app.get("/numpy")
async def numpy_sum():
    return {"sum": int(np.arange(10).sum())}


@app.get("/outbound")
async def outbound():
    async with httpx.AsyncClient() as client:
        response = await client.get("https://example.com/")
    return {"status": response.status_code}


class Default(WorkerEntrypoint):
    async def fetch(self, request):
        return await asgi.fetch(app, request, self.env)
