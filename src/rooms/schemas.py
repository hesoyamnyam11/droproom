from pydantic import BaseModel, Field

ROOM_CODE_PATTERN = r"^[A-HJ-NP-Z2-9]{6}$"


class RoomCreateResponse(BaseModel):
    code: str = Field(..., pattern=ROOM_CODE_PATTERN)
    ttl_seconds: int
    expires_at: float
    join_url: str
    qr_svg: str
    ice_servers: list[dict]


class RoomInfoResponse(BaseModel):
    code: str
    peer_count: int
    is_full: bool
    remaining_seconds: int
    ice_servers: list[dict]


class RoomDeleteResponse(BaseModel):
    status: str
    code: str
