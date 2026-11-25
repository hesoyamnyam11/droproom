from functools import lru_cache
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    app_name: str = "DropRoom"
    app_env: str = "development"
    host: str = "0.0.0.0"
    port: int = 8000
    allowed_origins: str = "http://127.0.0.1:8000,http://localhost:8000"

    room_ttl_seconds: int = 600
    max_active_rooms: int = 200
    rate_limit_create_room: str = "20/minute"
    rate_limit_read: str = "60/minute"
    ws_max_message_bytes: int = 65536

    # Opsional: TURN server untuk jaringan firewall super ketat
    turn_url: str = ""
    turn_username: str = ""
    turn_credential: str = ""

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    @property
    def cors_origins_list(self) -> list[str]:
        return [
            origin.strip()
            for origin in self.allowed_origins.split(",")
            if origin.strip()
        ]

    @property
    def ice_servers(self) -> list[dict]:
        servers: list[dict] = [
            {"urls": ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"]},
            {"urls": "stun:stun.cloudflare.com:3478"},
        ]
        if self.turn_url and self.turn_username and self.turn_credential:
            servers.append(
                {
                    "urls": self.turn_url,
                    "username": self.turn_username,
                    "credential": self.turn_credential,
                }
            )
        return servers


@lru_cache
def get_settings() -> Settings:
    return Settings()
