"""解析程序源码目录与运行数据目录，避免把业务数据写进源码仓库。"""

from __future__ import annotations

import os
import shutil
import sys
from pathlib import Path


APP_DATA_ENV = "PAYROLL_DATA_DIR"
APP_DATA_NAME = "Cyber Payroll"


def resolve_data_directory(project_root: Path, configured: Path | None = None) -> Path:
    """返回源码之外的运行数据目录。

    ``PAYROLL_DATA_DIR`` 只用于用户明确指定数据位置；默认位置使用操作系统的
    用户应用数据目录。禁止把运行目录设置为源码目录或源码目录的子目录，避免
    发布时误把数据库、结果和 API 配置加入 GitHub。
    """
    project_root = Path(project_root).resolve()
    raw_configured = configured or os.environ.get(APP_DATA_ENV, "").strip()
    if raw_configured:
        data_dir = Path(raw_configured).expanduser().resolve()
    elif sys.platform == "darwin":
        data_dir = Path.home() / "Library" / "Application Support" / APP_DATA_NAME
    elif os.name == "nt":
        data_dir = Path(os.environ.get("LOCALAPPDATA") or Path.home() / "AppData" / "Local") / APP_DATA_NAME
    else:
        data_dir = Path(os.environ.get("XDG_DATA_HOME") or Path.home() / ".local" / "share") / "cyber-payroll"
    data_dir = data_dir.resolve()
    try:
        data_dir.relative_to(project_root)
    except ValueError:
        return data_dir
    raise ValueError(f"运行数据目录不能位于源码目录内：{data_dir}")


def prepare_data_directory(project_root: Path, configured: Path | None = None) -> Path:
    """创建运行目录，并安全迁移一次旧版源码目录中的运行数据。

    迁移只复制已知的运行文件，不删除旧文件；因此升级失败时仍可从原目录恢复。
    迁移完成后，应用只使用新的外部目录，源码目录中的旧文件由发布前清理流程处理。
    """
    project_root = Path(project_root).resolve()
    data_dir = resolve_data_directory(project_root, configured)
    data_dir.mkdir(parents=True, exist_ok=True)
    marker = data_dir / ".legacy-runtime-migrated"
    if marker.exists():
        return data_dir

    legacy_organizations = project_root / "organizations"
    target_organizations = data_dir / "organizations"
    if legacy_organizations.is_dir() and not legacy_organizations.is_symlink() and not target_organizations.exists():
        shutil.copytree(legacy_organizations, target_organizations, symlinks=False)

    for filename in ("app_config.db", "system_config.json"):
        source = project_root / filename
        destination = data_dir / filename
        if source.is_file() and not source.is_symlink() and not destination.exists():
            shutil.copy2(source, destination)

    marker.write_text("旧版运行数据已安全迁移；源码目录中的旧文件未删除。\n", encoding="utf-8")
    return data_dir
