import asyncio
from contextlib import asynccontextmanager
from pathlib import Path
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from slowapi import _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded

from src.config import get_settings
from src.dependencies import limiter
from src.rooms.router import router as rooms_router
from src.rooms.service import RoomManager

settings = get_settings()
BASE_DIR = Path(__file__).resolve().parent.parent
FRONTEND_DIR = BASE_DIR / "frontend"


async def _cleanup_loop(manager: RoomManager) -> None:
    while True:
        await asyncio.sleep(15)
        await manager.cleanup_expired_rooms()


@asynccontextmanager
async def lifespan(app: FastAPI):
    manager = RoomManager(
        ttl_seconds=settings.room_ttl_seconds,
        max_rooms=settings.max_active_rooms,
    )
    app.state.room_manager = manager
    cleanup_task = asyncio.create_task(_cleanup_loop(manager))
    try:
        yield
    finally:
        cleanup_task.cancel()
        try:
            await cleanup_task
        except asyncio.CancelledError:
            pass


app = FastAPI(
    title=settings.app_name,
    version="1.0.0",
    docs_url="/api/docs" if settings.app_env == "development" else None,
    redoc_url=None,
    lifespan=lifespan,
)

app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins_list,
    allow_credentials=False,
    allow_methods=["GET", "POST", "DELETE"],
    allow_headers=["Accept", "Content-Type"],
)


@app.middleware("http")
async def add_security_headers(request: Request, call_next):
    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
    return response


@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception):
    return JSONResponse(
        status_code=500,
        content={"detail": "Terjadi kendala pada server. Silakan coba lagi."},
    )


@app.get("/api/health", tags=["health"])
async def health_check():
    return {"status": "ok", "app": settings.app_name}


app.include_router(rooms_router)

app.mount("/css", StaticFiles(directory=FRONTEND_DIR / "css"), name="css")
app.mount("/js", StaticFiles(directory=FRONTEND_DIR / "js"), name="js")


@app.get("/", include_in_schema=False)
async def serve_index():
    return FileResponse(FRONTEND_DIR / "index.html")
