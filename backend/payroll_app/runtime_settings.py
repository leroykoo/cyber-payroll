"""本地运行资源配置。"""

from __future__ import annotations

import json
import tempfile
from pathlib import Path
from typing import Any


DEFAULT_MAX_UPLOAD_MB = 256
MIN_MAX_UPLOAD_MB = 16
MAX_MAX_UPLOAD_MB = 1024 * 1024  # 1 TB；实际可用空间仍由操作系统和磁盘决定。


class RuntimeSettingsStore:
    """保存不属于某个组织的本地服务运行参数。"""

    def __init__(self, path: Path) -> None:
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)

    @staticmethod
    def defaults() -> dict[str, int]:
        return {"max_upload_mb": DEFAULT_MAX_UPLOAD_MB}

    def get(self) -> dict[str, int]:
        try:
            raw = json.loads(self.path.read_text(encoding="utf-8"))
        except (FileNotFoundError, json.JSONDecodeError, OSError):
            raw = {}
        value = raw.get("max_upload_mb", DEFAULT_MAX_UPLOAD_MB) if isinstance(raw, dict) else DEFAULT_MAX_UPLOAD_MB
        return {"max_upload_mb": self._normalize_limit(value)}

    def save(self, value: dict[str, Any]) -> dict[str, int]:
        if not isinstance(value, dict):
            raise ValueError("运行配置格式不正确")
        normalized = {"max_upload_mb": self._normalize_limit(value.get("max_upload_mb"))}
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=self.path.parent, delete=False) as stream:
            json.dump(normalized, stream, ensure_ascii=False, indent=2)
            temporary = Path(stream.name)
        temporary.replace(self.path)
        return normalized

    @staticmethod
    def _normalize_limit(value: Any) -> int:
        try:
            number = int(value)
        except (TypeError, ValueError) as exc:
            raise ValueError("真实数据文件大小上限必须是整数 MB") from exc
        if not MIN_MAX_UPLOAD_MB <= number <= MAX_MAX_UPLOAD_MB:
            raise ValueError(f"真实数据文件大小上限必须在 {MIN_MAX_UPLOAD_MB} MB 到 {MAX_MAX_UPLOAD_MB // 1024} GB 之间")
        return number
