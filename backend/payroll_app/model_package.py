from __future__ import annotations

import hashlib
import json
import zipfile
from datetime import datetime, timezone
from pathlib import Path


class CalculationModelPackage:
    """导出不含真实业务数据的组织级 Calculation Model。"""

    REQUIRED_FILES = {"manifest.json", "relationships.json", "business_logic.md", "output_schema.json", "calculator.py", "validators.py", "version.json"}

    @classmethod
    def export(cls, organization_dir: Path, version: str, destination: Path) -> Path:
        model_dir = Path(organization_dir) / "packages" / "models" / version
        missing = [name for name in cls.REQUIRED_FILES if not (model_dir / name).exists()]
        if missing:
            raise FileNotFoundError(f"模型包缺少文件: {', '.join(sorted(missing))}")
        destination = Path(destination)
        destination.parent.mkdir(parents=True, exist_ok=True)
        digest = hashlib.sha256()
        with zipfile.ZipFile(destination, "w", zipfile.ZIP_DEFLATED) as archive:
            for path in sorted(model_dir.rglob("*")):
                if path.is_file():
                    archive.write(path, path.relative_to(model_dir.parent))
                    digest.update(path.read_bytes())
            archive.writestr("package_manifest.json", json.dumps({"package_type": "calculation_model", "model_version": version, "created_at": datetime.now(timezone.utc).isoformat(), "checksum": digest.hexdigest()}, ensure_ascii=False, indent=2))
        return destination
