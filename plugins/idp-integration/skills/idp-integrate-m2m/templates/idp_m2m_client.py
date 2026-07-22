"""
IdpM2MClient — obtains and caches an Overlens M2M access token (Python).

OAuth 2.0 client_credentials (RFC 6749 §4.4). No user, no refresh token, no cookies.
The token lives 5 minutes; this client caches it in memory and refetches at exp - 30s,
so you do NOT hit POST /auth/token on every outbound request.

Dependency: requests  (pip install requests). Swap for httpx if you prefer async.
Thread-safe: a lock guards the cache so concurrent workers share one fetch.
"""

from __future__ import annotations

import base64
import threading
import time
from dataclasses import dataclass, field


@dataclass
class IdpM2MClient:
    idp_base_url: str          # e.g. "https://idp.overlens.com.br"
    client_id: str             # the registered M2M client_id, e.g. "fractals-service"
    client_secret: str         # from POST /admin/clients (keep in a secret manager)
    scopes: list[str]          # e.g. ["fractals:debit", "fractals:read"]
    safety_margin_seconds: int = 30

    _token: str | None = field(default=None, init=False, repr=False)
    _expires_at: float = field(default=0.0, init=False, repr=False)
    _lock: threading.Lock = field(default_factory=threading.Lock, init=False, repr=False)

    def get_token(self) -> str:
        """Return a valid Bearer token, fetching a fresh one only when the cache is stale."""
        now = time.time()
        if self._token and self._expires_at - self.safety_margin_seconds > now:
            return self._token

        with self._lock:
            # Re-check inside the lock — another thread may have refreshed it.
            now = time.time()
            if self._token and self._expires_at - self.safety_margin_seconds > now:
                return self._token
            return self._fetch_token()

    def auth_header(self) -> dict[str, str]:
        """Convenience: header dict to merge into an outbound request to a Resource Server."""
        return {"Authorization": f"Bearer {self.get_token()}"}

    def _fetch_token(self) -> str:
        import requests  # local import keeps the module importable without requests installed

        basic = base64.b64encode(f"{self.client_id}:{self.client_secret}".encode()).decode()
        data = {"grant_type": "client_credentials"}
        # Omit `scope` entirely to receive all the client's allowedScopes.
        if self.scopes:
            data["scope"] = " ".join(self.scopes)

        resp = requests.post(
            f"{self.idp_base_url}/auth/token",
            headers={
                "Content-Type": "application/x-www-form-urlencoded",
                "Authorization": f"Basic {basic}",
            },
            data=data,
            timeout=10,
        )
        if not resp.ok:
            # Surface status for diagnostics; never log the secret.
            raise RuntimeError(f"Overlens M2M token request failed: {resp.status_code} {resp.text}")

        payload = resp.json()
        self._token = payload["access_token"]
        self._expires_at = time.time() + payload["expires_in"]
        return self._token


# ──────────────────────────────── Usage ────────────────────────────────
#
# import os
# idp = IdpM2MClient(
#     idp_base_url=os.environ["IDP_BASE_URL"],
#     client_id=os.environ["IDP_M2M_CLIENT_ID"],
#     client_secret=os.environ["IDP_M2M_CLIENT_SECRET"],
#     scopes=[s for s in os.environ.get("IDP_M2M_SCOPES", "").split(",") if s],
# )
#
# import requests
# requests.post(
#     f"{os.environ['API_BASE_URL']}/fractals/debit",
#     headers={**idp.auth_header(), "Content-Type": "application/json"},
#     json={"userId": user_id, "amount": 10},
#     timeout=10,
# )
