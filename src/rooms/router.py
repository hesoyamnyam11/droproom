import json
from typing import Annotated
from fastapi import APIRouter, HTTPException, Path, Request, WebSocket, WebSocketDisconnect

from src.config import get_settings
from src.dependencies import limiter
from src.rooms.schemas import (
    ROOM_CODE_PATTERN,
    RoomCreateResponse,
    RoomDeleteResponse,
    RoomInfoResponse,
)
from src.rooms.service import RoomManager, generate_qr_svg

settings = get_settings()
router = APIRouter(tags=["rooms"])

ALLOWED_SIGNAL_TYPES = {"offer", "answer", "ice", "close_room"}


def get_room_manager(request: Request) -> RoomManager:
    return request.app.state.room_manager


@router.post("/api/v1/rooms", response_model=RoomCreateResponse)
@limiter.limit(settings.rate_limit_create_room)
async def create_room(request: Request) -> RoomCreateResponse:
    manager = get_room_manager(request)
    try:
        room = await manager.create_room()
    except OverflowError:
        raise HTTPException(
            status_code=503,
            detail="Server sedang penuh. Coba lagi beberapa saat.",
        )

    base_url = str(request.base_url).rstrip("/")
    join_url = f"{base_url}/?room={room.code}"
    qr_svg = generate_qr_svg(join_url)

    return RoomCreateResponse(
        code=room.code,
        ttl_seconds=room.remaining_seconds(),
        expires_at=room.expires_at,
        join_url=join_url,
        qr_svg=qr_svg,
        ice_servers=settings.ice_servers,
    )


@router.get("/api/v1/rooms/{code}", response_model=RoomInfoResponse)
@limiter.limit(settings.rate_limit_read)
async def get_room_info(
    request: Request,
    code: Annotated[str, Path(pattern=ROOM_CODE_PATTERN)],
) -> RoomInfoResponse:
    manager = get_room_manager(request)
    room = await manager.get_room(code.upper())
    if room is None:
        raise HTTPException(
            status_code=404,
            detail="Ruangan tidak ditemukan atau sudah kedaluwarsa.",
        )

    return RoomInfoResponse(
        code=room.code,
        peer_count=len(room.peers),
        is_full=len(room.peers) >= 2,
        remaining_seconds=room.remaining_seconds(),
        ice_servers=settings.ice_servers,
    )


@router.delete("/api/v1/rooms/{code}", response_model=RoomDeleteResponse)
@limiter.limit(settings.rate_limit_read)
async def delete_room(
    request: Request,
    code: Annotated[str, Path(pattern=ROOM_CODE_PATTERN)],
) -> RoomDeleteResponse:
    manager = get_room_manager(request)
    deleted = await manager.destroy_room(code.upper(), reason="room_closed")
    if not deleted:
        raise HTTPException(
            status_code=404,
            detail="Ruangan sudah ditutup atau tidak ditemukan.",
        )
    return RoomDeleteResponse(status="deleted", code=code.upper())


@router.websocket("/ws/{code}")
async def room_signaling_ws(websocket: WebSocket, code: str) -> None:
    clean_code = code.upper().strip()
    if len(clean_code) != 6 or not all(c.isalnum() for c in clean_code):
        await websocket.close(code=1008)
        return

    await websocket.accept()
    manager: RoomManager = websocket.app.state.room_manager

    room, role, error_code = await manager.register_peer(clean_code, websocket)
    if error_code or room is None or role is None:
        await websocket.send_json({"type": "error", "code": error_code or "room_not_found"})
        await websocket.close(code=1008)
        return

    try:
        # Kirim status bergabung ke perangkat ini
        await websocket.send_json(
            {
                "type": "joined",
                "role": role,
                "peer_count": len(room.peers),
                "remaining_seconds": room.remaining_seconds(),
            }
        )

        # Jika perangkat kedua masuk, beri tahu perangkat pertama untuk memulai WebRTC offer
        if len(room.peers) == 2:
            other_ws = await manager.get_other_peer(clean_code, role)
            if other_ws is not None:
                await other_ws.send_json({"type": "peer_joined", "peer_count": 2})

        while True:
            raw_text = await websocket.receive_text()
            if len(raw_text.encode("utf-8")) > settings.ws_max_message_bytes:
                await websocket.send_json({"type": "error", "code": "payload_too_large"})
                continue

            try:
                message = json.loads(raw_text)
            except json.JSONDecodeError:
                continue

            msg_type = message.get("type")
            if msg_type not in ALLOWED_SIGNAL_TYPES:
                continue

            if msg_type == "close_room":
                await manager.destroy_room(clean_code, reason="room_closed")
                return

            other_ws = await manager.get_other_peer(clean_code, role)
            if other_ws is not None:
                await other_ws.send_json(message)

    except WebSocketDisconnect:
        other_ws = await manager.unregister_peer(clean_code, role)
        if other_ws is not None:
            try:
                await other_ws.send_json({"type": "peer_left"})
            except Exception:
                pass
    except Exception:
        await manager.unregister_peer(clean_code, role)
