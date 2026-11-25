import asyncio
import io
import secrets
import time
from dataclasses import dataclass, field
from fastapi import WebSocket
import segno

# Karakter aman tanpa 0, O, 1, I agar mudah dibaca dari layar laptop ke HP
ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"


@dataclass
class Room:
    code: str
    created_at: float
    expires_at: float
    peers: dict[str, WebSocket] = field(default_factory=dict)  # role ("host"|"guest") -> ws

    def is_expired(self, now: float | None = None) -> bool:
        current = now if now is not None else time.time()
        return current >= self.expires_at

    def remaining_seconds(self, now: float | None = None) -> int:
        current = now if now is not None else time.time()
        return max(0, int(self.expires_at - current))


class RoomManager:
    def __init__(self, ttl_seconds: int = 600, max_rooms: int = 200) -> None:
        self.ttl_seconds = ttl_seconds
        self.max_rooms = max_rooms
        self._rooms: dict[str, Room] = {}
        self._lock = asyncio.Lock()

    def _generate_code(self) -> str:
        for _ in range(20):
            code = "".join(secrets.choice(ALPHABET) for _ in range(6))
            if code not in self._rooms:
                return code
        raise RuntimeError("Gagal membuat kode ruangan unik.")

    async def create_room(self) -> Room:
        async with self._lock:
            self._prune_expired_sync()
            if len(self._rooms) >= self.max_rooms:
                raise OverflowError("Batas ruangan aktif sementara penuh.")
            now = time.time()
            code = self._generate_code()
            room = Room(code=code, created_at=now, expires_at=now + self.ttl_seconds)
            self._rooms[code] = room
            return room

    async def get_room(self, code: str) -> Room | None:
        async with self._lock:
            room = self._rooms.get(code)
            if room is None:
                return None
            if room.is_expired():
                del self._rooms[code]
                return None
            return room

    async def register_peer(self, code: str, ws: WebSocket) -> tuple[Room | None, str | None, str | None]:
        """Mendaftarkan perangkat ke ruangan. Mengembalikan (room, role, error_code)."""
        async with self._lock:
            room = self._rooms.get(code)
            if room is None or room.is_expired():
                if code in self._rooms:
                    del self._rooms[code]
                return None, None, "room_not_found"

            if len(room.peers) >= 2:
                return None, None, "room_full"

            role = "host" if "host" not in room.peers else "guest"
            room.peers[role] = ws
            return room, role, None

    async def unregister_peer(self, code: str, role: str) -> WebSocket | None:
        """Menghapus peer yang terputus dan mengembalikan peer lain jika masih ada."""
        async with self._lock:
            room = self._rooms.get(code)
            if room is None:
                return None
            room.peers.pop(role, None)
            other_role = "guest" if role == "host" else "host"
            return room.peers.get(other_role)

    async def get_other_peer(self, code: str, role: str) -> WebSocket | None:
        async with self._lock:
            room = self._rooms.get(code)
            if room is None or room.is_expired():
                return None
            other_role = "guest" if role == "host" else "host"
            return room.peers.get(other_role)

    async def destroy_room(self, code: str, reason: str = "room_closed") -> bool:
        """Menghapus ruangan secara permanen dan memutus seluruh perangkat di dalamnya."""
        async with self._lock:
            room = self._rooms.pop(code, None)

        if room is None:
            return False

        for ws in list(room.peers.values()):
            try:
                await ws.send_json({"type": reason})
                await ws.close(code=1000)
            except Exception:
                pass
        return True

    def _prune_expired_sync(self) -> list[Room]:
        now = time.time()
        expired_codes = [c for c, r in self._rooms.items() if r.is_expired(now)]
        expired_rooms = [self._rooms.pop(c) for c in expired_codes]
        return expired_rooms

    async def cleanup_expired_rooms(self) -> None:
        async with self._lock:
            expired_rooms = self._prune_expired_sync()

        for room in expired_rooms:
            for ws in list(room.peers.values()):
                try:
                    await ws.send_json({"type": "room_expired"})
                    await ws.close(code=1000)
                except Exception:
                    pass


def generate_qr_svg(url: str) -> str:
    qr = segno.make(url, error="m")
    buffer = io.BytesIO()
    qr.save(buffer, kind="svg", xmldecl=False, svgclass="qr-svg", scale=6, border=2, dark="#111827", light="#FFFFFF")
    return buffer.getvalue().decode("utf-8")
