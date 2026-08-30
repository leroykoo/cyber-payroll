"""本地 AI 服务商配置与兼容 API 客户端。"""

from __future__ import annotations

import json
import tempfile
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


PROVIDERS = {
    "deepseek": {"label": "DeepSeek", "base_url": "https://api.deepseek.com/v1", "model": "deepseek-chat"},
    "glm": {"label": "智谱 GLM", "base_url": "https://open.bigmodel.cn/api/paas/v4", "model": "glm-4.5"},
    "openai": {"label": "ChatGPT / OpenAI", "base_url": "https://api.openai.com/v1", "model": "gpt-5"},
    "custom": {"label": "自定义兼容 API", "base_url": "", "model": ""},
}


class AISettingsStore:
    """系统级通用配置保存在独立 JSON 文件，不随组织 SQLite 搬迁。"""

    def __init__(self, db_path: Path) -> None:
        self.config_path = Path(db_path).with_suffix(".json")
        self.config_path.parent.mkdir(parents=True, exist_ok=True)

    def get(self, *, include_key: bool = False) -> dict[str, Any]:
        try:
            value = json.loads(self.config_path.read_text(encoding="utf-8"))
        except (FileNotFoundError, json.JSONDecodeError):
            value = self.defaults()
        if not include_key:
            value["api_key_configured"] = bool(value.get("api_key"))
            value["api_key"] = self.mask_key(value.get("api_key", ""))
        return value

    def save(self, value: dict[str, Any]) -> dict[str, Any]:
        current = self.get(include_key=True)
        provider = value.get("provider", current["provider"])
        if provider not in PROVIDERS:
            raise ValueError("不支持的 AI 服务商")
        result = {
            "provider": provider,
            "base_url": str(value.get("base_url", current.get("base_url", ""))).rstrip("/"),
            "model": str(value.get("model", current.get("model", ""))).strip(),
            "api_key": str(value.get("api_key") or current.get("api_key", "")).strip(),
        }
        if "api_key" in value and "•" in str(value.get("api_key")):
            result["api_key"] = current.get("api_key", "")
        if not result["base_url"] or not result["model"]:
            raise ValueError("API 地址和模型名称不能为空")
        if not result["base_url"].startswith("https://"):
            raise ValueError("API 地址必须使用 HTTPS")
        self.config_path.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=self.config_path.parent, delete=False) as stream:
            json.dump(result, stream, ensure_ascii=False, indent=2)
            temporary = Path(stream.name)
        temporary.replace(self.config_path)
        return self.get()

    @staticmethod
    def defaults() -> dict[str, str]:
        preset = PROVIDERS["deepseek"]
        return {"provider": "deepseek", "base_url": preset["base_url"], "model": preset["model"], "api_key": ""}

    @staticmethod
    def mask_key(value: str) -> str:
        key = str(value or "")
        if not key:
            return ""
        if len(key) <= 8:
            return "••••••••"
        return f"{key[:4]}••••••••{key[-4:]}"


class CompatibleAIClient:
    """调用 OpenAI 兼容 API 的本地客户端。"""

    def __init__(self, config: dict[str, Any]) -> None:
        self.config = config

    def list_models(self) -> list[str]:
        payload = self._get("/models")
        models = [item["id"] for item in payload.get("data", []) if isinstance(item, dict) and item.get("id")]
        return sorted(models)

    def test_connection(self) -> dict[str, Any]:
        models = self.list_models()
        return {"ok": True, "provider": self.config["provider"], "model_count": len(models), "configured_model_available": self.config["model"] in models}

    def complete(self, messages: list[dict[str, str]], *, temperature: float = 0.1) -> str:
        """请求文本补全；调用方必须负责校验结果，结果不会在本模块中执行。"""
        key = self.config.get("api_key")
        if not key:
            raise ValueError("请先保存 API Key")
        payload = json.dumps(
            {"model": self.config["model"], "messages": messages, "temperature": temperature},
            ensure_ascii=False,
        ).encode("utf-8")
        request = Request(
            self.config["base_url"] + "/chat/completions",
            data=payload,
            headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json", "Accept": "application/json"},
            method="POST",
        )
        try:
            with urlopen(request, timeout=180) as response:  # nosec B310 - URL is user-confirmed HTTPS configuration
                response_payload = json.loads(response.read().decode("utf-8"))
        except HTTPError as exc:
            raise ValueError(f"供应商返回 HTTP {exc.code}") from exc
        except URLError as exc:
            raise ValueError(f"无法连接供应商 API: {exc.reason}") from exc
        except TimeoutError as exc:
            raise ValueError("大模型请求超过 180 秒未返回，请减少本次生成的规则数量后分段生成") from exc
        try:
            return str(response_payload["choices"][0]["message"]["content"])
        except (KeyError, IndexError, TypeError) as exc:
            raise ValueError("AI 返回内容格式不符合 Chat Completions 规范") from exc

    def _get(self, path: str) -> dict[str, Any]:
        key = self.config.get("api_key")
        if not key:
            raise ValueError("请先保存 API Key")
        request = Request(self.config["base_url"] + path, headers={"Authorization": f"Bearer {key}", "Accept": "application/json"}, method="GET")
        try:
            with urlopen(request, timeout=15) as response:  # nosec B310 - URL is user-confirmed HTTPS configuration
                return json.loads(response.read().decode("utf-8"))
        except HTTPError as exc:
            raise ValueError(f"供应商返回 HTTP {exc.code}") from exc
        except URLError as exc:
            raise ValueError(f"无法连接供应商 API: {exc.reason}") from exc
