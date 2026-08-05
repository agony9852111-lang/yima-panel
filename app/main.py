"""易码 API 面板 — FastAPI 异步后端（支持并发）。"""
from __future__ import annotations

import asyncio
import random
from pathlib import Path
from typing import Any

import httpx
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

ROOT_DOMAIN_DEFAULT = "ejiema.com"
REQUEST_TIMEOUT = 30.0
BASE_DIR = Path(__file__).resolve().parent.parent
STATIC_DIR = BASE_DIR / "static"

app = FastAPI(title="易码面板", version="1.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class ApiConfig(BaseModel):
    root_domain: str = Field(default=ROOT_DOMAIN_DEFAULT, description="根域名，如 ejiema.com")
    token: str = Field(..., min_length=1, description="API Token")


class BalanceRequest(ApiConfig):
    pass


class GetPhoneRequest(ApiConfig):
    key_word: str = Field(..., min_length=1)
    phone: str = ""
    province: str = ""
    card_type: str = "全部"


class GetMsgRequest(ApiConfig):
    phone: str = Field(..., min_length=1)
    key_word: str = Field(..., min_length=1)


class RandomJobRequest(ApiConfig):
    keywords: list[str] = Field(..., min_length=1, description="关键词列表，将随机抽取")
    count: int = Field(default=1, ge=1, le=20, description="并发任务数")
    poll_times: int = Field(default=5, ge=1, le=30, description="每号查短信次数")
    poll_interval: float = Field(default=2.0, ge=0.5, le=10.0, description="查短信间隔秒")
    province: str = ""
    card_type: str = "全部"


def api_base(root_domain: str) -> str:
    d = root_domain.strip().lower()
    for p in ("https://", "http://", "www.", "app.", "api."):
        if d.startswith(p):
            d = d[len(p) :]
    d = d.strip("/").split("/")[0]
    if not d:
        raise HTTPException(400, "根域名无效")
    return f"https://api.{d}/zc/data.php"


async def call_open_api(
    client: httpx.AsyncClient,
    root_domain: str,
    code: str,
    token: str,
    extra: dict[str, str] | None = None,
) -> str:
    params: dict[str, str] = {"code": code, "token": token}
    if extra:
        for k, v in extra.items():
            if v is not None and str(v) != "":
                params[k] = str(v)
    url = api_base(root_domain)
    try:
        r = await client.get(url, params=params)
        text = (r.text or "").strip()
    except httpx.HTTPError as e:
        raise HTTPException(502, f"上游请求失败: {e}") from e
    if not text:
        raise HTTPException(502, "上游返回空响应")
    return text


def is_error(text: str) -> bool:
    return text.startswith("ERROR:")


@app.get("/api/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/api/balance")
async def balance(body: BalanceRequest) -> dict[str, Any]:
    async with httpx.AsyncClient(timeout=REQUEST_TIMEOUT, follow_redirects=True) as client:
        text = await call_open_api(client, body.root_domain, "leftAmount", body.token)
    return {"ok": not is_error(text), "raw": text, "balance": None if is_error(text) else text}


@app.post("/api/get-phone")
async def get_phone(body: GetPhoneRequest) -> dict[str, Any]:
    extra = {
        "keyWord": body.key_word,
        "phone": body.phone,
        "province": body.province,
        "cardType": body.card_type,
    }
    async with httpx.AsyncClient(timeout=REQUEST_TIMEOUT, follow_redirects=True) as client:
        text = await call_open_api(client, body.root_domain, "getPhone", body.token, extra)
    return {
        "ok": not is_error(text),
        "raw": text,
        "phone": None if is_error(text) else text,
        "key_word": body.key_word,
    }


@app.post("/api/get-msg")
async def get_msg(body: GetMsgRequest) -> dict[str, Any]:
    extra = {"phone": body.phone, "keyWord": body.key_word}
    async with httpx.AsyncClient(timeout=REQUEST_TIMEOUT, follow_redirects=True) as client:
        text = await call_open_api(client, body.root_domain, "getMsg", body.token, extra)
    pending = "[尚未收到]" in text
    return {
        "ok": not is_error(text),
        "pending": pending,
        "raw": text,
        "message": text,
        "phone": body.phone,
        "key_word": body.key_word,
    }


async def _random_one(
    client: httpx.AsyncClient,
    body: RandomJobRequest,
    index: int,
) -> dict[str, Any]:
    kw = random.choice(body.keywords).strip()
    if not kw:
        return {"index": index, "ok": False, "error": "关键词为空"}

    phone_text = await call_open_api(
        client,
        body.root_domain,
        "getPhone",
        body.token,
        {
            "keyWord": kw,
            "province": body.province,
            "cardType": body.card_type,
        },
    )
    if is_error(phone_text):
        return {"index": index, "ok": False, "key_word": kw, "error": phone_text}

    phone = phone_text.strip()
    messages: list[str] = []
    final_msg = ""
    for i in range(body.poll_times):
        msg = await call_open_api(
            client,
            body.root_domain,
            "getMsg",
            body.token,
            {"phone": phone, "keyWord": kw},
        )
        messages.append(msg)
        final_msg = msg
        if is_error(msg):
            return {
                "index": index,
                "ok": False,
                "key_word": kw,
                "phone": phone,
                "error": msg,
                "polls": messages,
            }
        if "[尚未收到]" not in msg:
            return {
                "index": index,
                "ok": True,
                "key_word": kw,
                "phone": phone,
                "message": msg,
                "polls": messages,
                "attempts": i + 1,
            }
        if i < body.poll_times - 1:
            await asyncio.sleep(body.poll_interval)

    return {
        "index": index,
        "ok": True,
        "pending": True,
        "key_word": kw,
        "phone": phone,
        "message": final_msg,
        "polls": messages,
        "attempts": body.poll_times,
    }


@app.post("/api/random-job")
async def random_job(body: RandomJobRequest) -> dict[str, Any]:
    cleaned = [k.strip() for k in body.keywords if k and k.strip()]
    if not cleaned:
        raise HTTPException(400, "请至少提供一个有效关键词")
    body.keywords = cleaned

    limits = httpx.Limits(max_connections=50, max_keepalive_connections=20)
    async with httpx.AsyncClient(
        timeout=REQUEST_TIMEOUT,
        follow_redirects=True,
        limits=limits,
    ) as client:
        tasks = [_random_one(client, body, i) for i in range(body.count)]
        results = await asyncio.gather(*tasks, return_exceptions=True)

    out: list[dict[str, Any]] = []
    for i, item in enumerate(results):
        if isinstance(item, Exception):
            out.append({"index": i, "ok": False, "error": str(item)})
        else:
            out.append(item)
    return {"ok": True, "count": len(out), "results": out}


@app.get("/")
async def index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")


app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")
