from __future__ import annotations

import sqlite3
import re
import shutil
from datetime import datetime, timezone
from pathlib import Path


class OrganizationRegistry:
    """只保存组织目录索引，不保存组织业务数据。"""

    DEFAULT_ORGANIZATION_ID = "default_org"
    DEFAULT_ORGANIZATION_NAME = "立天世纪"

    def __init__(self, workspace: Path) -> None:
        self.workspace = Path(workspace)
        self.workspace.mkdir(parents=True, exist_ok=True)
        self.db_path = self.workspace / "app_config.db"
        with sqlite3.connect(self.db_path) as conn:
            conn.execute("CREATE TABLE IF NOT EXISTS organizations (organization_id TEXT PRIMARY KEY, display_name TEXT NOT NULL, storage_path TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL)")
        self._repair_migrated_storage_paths()

    def _repair_migrated_storage_paths(self) -> None:
        """将旧版复制过来的组织记录指向当前外部数据目录。

        旧版本把源码目录绝对路径写入了注册表。迁移数据库后不能继续信任这个
        路径，否则程序会重新读写源码目录中的业务数据。这里只允许重定位到
        当前外部数据目录下、且名称与 organization_id 一致的已知目录。
        """
        organizations_root = (self.workspace / "organizations").resolve()
        with sqlite3.connect(self.db_path) as conn:
            rows = conn.execute("SELECT organization_id, storage_path FROM organizations").fetchall()
            for organization_id, storage_path in rows:
                expected = organizations_root / str(organization_id)
                try:
                    current = Path(storage_path).resolve()
                except (OSError, RuntimeError):
                    current = Path(storage_path)
                try:
                    current.relative_to(organizations_root)
                except ValueError:
                    if expected.is_symlink():
                        raise ValueError(f"组织目录不能是符号链接：{expected}")
                    # 即使旧目录缺失，也不能继续信任源码目录中的旧路径；后续
                    # OrganizationDatabase 会在外部目录创建缺失的组织结构。
                    conn.execute("UPDATE organizations SET storage_path = ? WHERE organization_id = ?", (str(expected), organization_id))

    def create(self, organization_id: str, display_name: str) -> Path:
        if not re.fullmatch(r"[a-z][a-z0-9_-]{1,63}", organization_id):
            raise ValueError("组织技术标识必须以小写字母开头，只能包含小写字母、数字、下划线或短横线")
        org_dir = self.workspace / "organizations" / organization_id
        if org_dir.exists():
            raise ValueError("组织技术标识已存在")
        org_dir.mkdir(parents=True, exist_ok=True)
        for directory in ("databases", "config", "python", "results", "packages"):
            (org_dir / directory).mkdir(parents=True, exist_ok=True)
        with sqlite3.connect(self.db_path) as conn:
            conn.execute("INSERT INTO organizations VALUES (?, ?, ?, ?)", (organization_id, display_name, str(org_dir), datetime.now(timezone.utc).isoformat()))
        return org_dir

    def ensure_default(self) -> Path:
        """确保首次安装和旧安装中始终存在可直接使用的默认组织。"""
        standard_dir = self.workspace / "organizations" / self.DEFAULT_ORGANIZATION_ID
        organizations_root = (self.workspace / "organizations").resolve()
        with sqlite3.connect(self.db_path) as conn:
            existing = conn.execute("SELECT storage_path FROM organizations WHERE organization_id = ?", (self.DEFAULT_ORGANIZATION_ID,)).fetchone()
        org_dir = standard_dir
        if existing and existing[0]:
            candidate = Path(existing[0]).resolve()
            try:
                candidate.relative_to(organizations_root)
            except ValueError:
                candidate = standard_dir
            if candidate.name == self.DEFAULT_ORGANIZATION_ID and not candidate.is_symlink():
                org_dir = candidate
        org_dir.mkdir(parents=True, exist_ok=True)
        for directory in ("databases", "config", "python", "results", "packages"):
            (org_dir / directory).mkdir(parents=True, exist_ok=True)
        now = datetime.now(timezone.utc).isoformat()
        with sqlite3.connect(self.db_path) as conn:
            if existing is None:
                conn.execute("INSERT INTO organizations VALUES (?, ?, ?, ?)", (self.DEFAULT_ORGANIZATION_ID, self.DEFAULT_ORGANIZATION_NAME, str(org_dir), now))
            else:
                conn.execute("UPDATE organizations SET display_name = ?, storage_path = ? WHERE organization_id = ?", (self.DEFAULT_ORGANIZATION_NAME, str(org_dir), self.DEFAULT_ORGANIZATION_ID))
        return org_dir

    def delete(self, organization_id: str) -> None:
        if organization_id == self.DEFAULT_ORGANIZATION_ID:
            raise ValueError("立天世纪是程序默认组织，不能删除")
        with sqlite3.connect(self.db_path) as conn:
            row = conn.execute("SELECT storage_path FROM organizations WHERE organization_id = ?", (organization_id,)).fetchone()
            if row is None:
                raise ValueError("未找到组织")
            count = conn.execute("SELECT COUNT(*) FROM organizations").fetchone()[0]
            if count <= 1:
                raise ValueError("至少需要保留一个组织")
            conn.execute("DELETE FROM organizations WHERE organization_id = ?", (organization_id,))
        storage_path = Path(row[0]).resolve()
        if storage_path.parent != (self.workspace / "organizations").resolve():
            raise ValueError("组织存储目录不在允许范围内")
        shutil.rmtree(storage_path)

    def list(self) -> list[dict[str, str]]:
        with sqlite3.connect(self.db_path) as conn:
            conn.row_factory = sqlite3.Row
            return [dict(row) for row in conn.execute("SELECT * FROM organizations ORDER BY display_name")]
