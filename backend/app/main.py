import math
from collections import deque
from contextlib import asynccontextmanager
from time import monotonic
from typing import Optional

import httpx
from fastapi import FastAPI, HTTPException
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from .config import ROOT_DIR, Settings, load_settings
from .opencode_go import API_BASE_URL
from .schemas import AskAnswer, AskQuestion
from .solver import solve


class RateLimiter:
    """A bounded, process-wide quota for this small single-worker app."""

    def __init__(self, limit: int = 10, window: int = 60):
        self.limit = limit
        self.window = window
        self.requests: deque[float] = deque()

    def check(self):
        now = monotonic()
        while self.requests and self.requests[0] <= now - self.window:
            self.requests.popleft()
        if len(self.requests) >= self.limit:
            retry_after = max(1, math.ceil(self.window - (now - self.requests[0])))
            raise HTTPException(
                429,
                f"Слишком много запросов. Повторите через {retry_after} сек.",
                headers={"Retry-After": str(retry_after)},
            )
        self.requests.append(now)


def create_app(
    settings: Optional[Settings] = None,
    transport: Optional[httpx.AsyncBaseTransport] = None,
) -> FastAPI:
    settings = settings if settings is not None else load_settings()
    limiter = RateLimiter()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        async with httpx.AsyncClient(
            base_url=API_BASE_URL,
            timeout=httpx.Timeout(180, connect=10),
            transport=transport,
        ) as client:
            app.state.opencode_go_client = client
            yield

    app = FastAPI(title="Challenge API", lifespan=lifespan)

    @app.middleware("http")
    async def prevent_api_caching(request, call_next):
        response = await call_next(request)
        if request.url.path.startswith("/api/"):
            response.headers["Cache-Control"] = "no-store"
        return response

    @app.exception_handler(RequestValidationError)
    async def validation_error(request, exc):
        return JSONResponse(
            status_code=422,
            content={"detail": "Проверьте формат запроса: непустой вопрос, режим, UUID диалога и историю переписки."},
        )

    @app.get("/api/health")
    async def health():
        return {"status": "ok"}

    @app.post("/api/ask", response_model=AskAnswer)
    async def ask(payload: AskQuestion):
        if not settings.api_key:
            raise HTTPException(503, "Добавьте OPENCODE_GO_API_KEY из OpenCode Console в корневой .env и перезапустите сервер.")
        limiter.check()
        return await solve(payload, settings, app.state.opencode_go_client)

    # Only the compiled frontend is public. The root .env is never served.
    frontend_dist = ROOT_DIR / "frontend" / "dist"
    if frontend_dist.is_dir():
        app.mount("/", StaticFiles(directory=frontend_dist, html=True), name="frontend")

    return app
