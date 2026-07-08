# relay_client.py
# SKYNET Relay Client v0.1
#
# Keeps a secure outbound WebSocket connection from Sergey's PC to Cloudflare Worker.
# It replaces ngrok during development by proxying Cloudflare requests to local MCP:
#   Cloudflare Worker -> this relay client -> http://127.0.0.1:8000/mcp
#
# Requirements:
#   python -m pip install websockets

from __future__ import annotations

import asyncio
import base64
import json
import os
import sys
import time
import traceback
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

try:
    import websockets
except Exception as exc:
    print("[relay] Missing dependency: websockets")
    print("[relay] Install it with: python -m pip install websockets")
    raise

RELAY_URL = os.getenv("SKYNET_RELAY_URL", "").strip()
LOCAL_MCP_BASE = os.getenv("LOCAL_MCP_BASE", "http://127.0.0.1:8000").rstrip("/")
REQUEST_TIMEOUT = float(os.getenv("SKYNET_RELAY_REQUEST_TIMEOUT", "60"))

BLOCKED_REQUEST_HEADERS = {
    "host",
    "connection",
    "content-length",
    "accept-encoding",
    "cf-connecting-ip",
    "cf-ipcountry",
    "cf-ray",
    "cf-visitor",
    "x-forwarded-for",
    "x-forwarded-proto",
}

BLOCKED_RESPONSE_HEADERS = {
    "connection",
    "content-length",
    "transfer-encoding",
    "content-encoding",
    "keep-alive",
    "server",
}


def b64_to_bytes(value: str | None) -> bytes:
    if not value:
        return b""
    return base64.b64decode(value.encode("ascii"))


def bytes_to_b64(value: bytes) -> str:
    if not value:
        return ""
    return base64.b64encode(value).decode("ascii")


def clean_request_headers(headers: dict[str, Any]) -> dict[str, str]:
    out: dict[str, str] = {}
    for key, value in (headers or {}).items():
        lower = str(key).lower()
        if lower in BLOCKED_REQUEST_HEADERS:
            continue
        if lower.startswith("cf-"):
            continue
        out[str(key)] = str(value)
    return out


def clean_response_headers(headers: Any) -> dict[str, str]:
    out: dict[str, str] = {}
    try:
        items = headers.items()
    except Exception:
        return out
    for key, value in items:
        lower = str(key).lower()
        if lower in BLOCKED_RESPONSE_HEADERS:
            continue
        out[str(key)] = str(value)
    return out


def build_local_url(path: str) -> str:
    if not path.startswith("/"):
        path = "/" + path
    # Cloudflare maps external /mcp/<token> to internal /mcp.
    # Any query string is preserved in path.
    return LOCAL_MCP_BASE + path


def forward_to_local_mcp(message: dict[str, Any]) -> dict[str, Any]:
    request_id = message.get("id", "")
    method = str(message.get("method") or "POST").upper()
    path = str(message.get("path") or "/mcp")
    local_url = build_local_url(path)
    body = b64_to_bytes(message.get("body_base64"))
    headers = clean_request_headers(message.get("headers") or {})

    if body and "content-type" not in {k.lower() for k in headers}:
        headers["content-type"] = "application/json; charset=utf-8"

    try:
        data = None if method in {"GET", "HEAD"} else body
        req = urllib.request.Request(local_url, data=data, method=method, headers=headers)
        with urllib.request.urlopen(req, timeout=REQUEST_TIMEOUT) as resp:
            resp_body = resp.read()
            status = int(resp.status)
            resp_headers = clean_response_headers(resp.headers)
    except urllib.error.HTTPError as exc:
        resp_body = exc.read()
        status = int(exc.code)
        resp_headers = clean_response_headers(exc.headers)
    except Exception as exc:
        err = {
            "ok": False,
            "error": "local_mcp_request_failed",
            "message": str(exc),
            "local_url": local_url,
        }
        resp_body = json.dumps(err, ensure_ascii=False).encode("utf-8")
        status = 502
        resp_headers = {"content-type": "application/json; charset=utf-8"}

    return {
        "type": "http_response",
        "id": request_id,
        "status": status,
        "headers": resp_headers,
        "body_base64": bytes_to_b64(resp_body),
    }


async def connect_forever() -> None:
    if not RELAY_URL:
        print("[relay] ERROR: SKYNET_RELAY_URL is empty.")
        print("[relay] Example:")
        print("[relay] set SKYNET_RELAY_URL=wss://YOUR_WORKER.workers.dev/agent/connect/YOUR_AGENT_TOKEN?device_id=sergey-pc")
        sys.exit(2)

    reconnect_delay = 2
    while True:
        try:
            print(f"[relay] Connecting to Cloudflare: {RELAY_URL}")
            print(f"[relay] Local MCP base: {LOCAL_MCP_BASE}")
            async with websockets.connect(
                RELAY_URL,
                ping_interval=20,
                ping_timeout=20,
                max_size=16 * 1024 * 1024,
            ) as ws:
                print("[relay] Connected. Ngrok is not needed while this window is open.")
                reconnect_delay = 2
                async for raw in ws:
                    try:
                        message = json.loads(raw)
                        msg_type = message.get("type")
                        if msg_type == "hello":
                            print(f"[relay] Server hello: {message}")
                            continue
                        if msg_type != "http_request":
                            print(f"[relay] Ignored message type: {msg_type}")
                            continue

                        request_id = message.get("id")
                        path = message.get("path")
                        method = message.get("method")
                        print(f"[relay] -> local {method} {path} id={request_id}")

                        response = await asyncio.to_thread(forward_to_local_mcp, message)
                        await ws.send(json.dumps(response, ensure_ascii=False))
                        print(f"[relay] <- status {response.get('status')} id={request_id}")
                    except Exception:
                        print("[relay] Request handling error:")
                        traceback.print_exc()
        except Exception as exc:
            print(f"[relay] Disconnected/error: {exc}")
            print(f"[relay] Reconnect in {reconnect_delay}s...")
            await asyncio.sleep(reconnect_delay)
            reconnect_delay = min(30, reconnect_delay * 2)


if __name__ == "__main__":
    try:
        asyncio.run(connect_forever())
    except KeyboardInterrupt:
        print("\n[relay] Stopped by user.")
