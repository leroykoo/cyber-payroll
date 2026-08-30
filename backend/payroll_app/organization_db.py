from __future__ import annotations

import re
import json
import sqlite3
import uuid
import hashlib
import shutil
import tempfile
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable

from .safe_python import validate_rule_code

_IDENTIFIER = re.compile(r"^[a-z][a-z0-9_]{0,62}$")
_SYSTEM_IDENTIFIER = re.compile(r"^_sys_[a-z][a-z0-9_]{0,62}$")
_SQL_TYPES = {"TEXT", "INTEGER", "REAL", "NUMERIC"}


class OrganizationDatabase:
    """组织存储门面：配置元数据与真实业务数据使用独立 SQLite。"""

    CONFIG_TABLES = (
        "data_pages", "data_page_fields", "schema_versions", "relationships",
        "calculation_models", "output_schemas", "output_field_rules",
        "temporary_calculation_fields", "audit_logs", "data_question_history",
        "payroll_input_configs", "configuration_versions",
    )
    DATA_TABLES = ("import_batches", "calculation_runs")

    def __init__(self, organization_dir: Path) -> None:
        self.organization_dir = Path(organization_dir)
        self.organization_dir.mkdir(parents=True, exist_ok=True)
        self.databases_dir = self.organization_dir / "databases"
        self.config_dir = self.organization_dir / "config"
        self.python_dir = self.organization_dir / "python"
        self.results_dir = self.organization_dir / "results"
        self.packages_dir = self.organization_dir / "packages"
        for directory in (self.databases_dir, self.config_dir, self.python_dir, self.results_dir, self.packages_dir):
            directory.mkdir(parents=True, exist_ok=True)
        self.configuration_db_path = self.databases_dir / "configuration.db"
        self.business_db_path = self.databases_dir / "business_data.db"
        # 兼容旧调用：db_path/connect() 明确指向轻量配置库。
        self.db_path = self.configuration_db_path
        self.models_dir = self.packages_dir / "models"
        self.logic_dir = self.config_dir
        self.output_dir = self.results_dir
        self.exports_dir = self.results_dir
        self.models_dir.mkdir(parents=True, exist_ok=True)
        self._initialize()
        self._migrate_legacy_database()

    @property
    def global_logic_path(self) -> Path:
        """组织专属全局计算逻辑：不与程序内置法定规则混放。"""
        return self.logic_dir / "global_calculation_logic.json"

    def load_global_logic(self) -> list[dict]:
        path = self.global_logic_path
        if not path.exists():
            return []
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            raise ValueError("组织全局计算逻辑文件不是合法 JSON") from exc
        items = payload.get("rules", []) if isinstance(payload, dict) else []
        if not isinstance(items, list):
            raise ValueError("组织全局计算逻辑文件格式无效")
        return items

    def save_global_logic(self, rules: Iterable[dict]) -> list[dict]:
        normalized = [item for item in rules if isinstance(item, dict)]
        payload = {"version": 1, "scope": "organization_global", "rules": normalized, "updated_at": datetime.now(timezone.utc).isoformat()}
        temporary = self.global_logic_path.with_suffix(".json.tmp")
        temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        temporary.replace(self.global_logic_path)
        with self.connect() as conn:
            self._append_audit(conn, "global_logic_saved", "organization_logic", "global_calculation_logic", {"rule_count": len(normalized)}, payload["updated_at"])
        self._sync_python_rules("global", normalized, name_keys=("project", "logicName", "name", "id"), code_keys=("generatedCode", "generated_code"))
        return normalized

    def connect(self) -> sqlite3.Connection:
        """兼容配置接口；真实业务读写必须显式调用 connect_data()。"""
        return self.connect_config()

    def connect_config(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.configuration_db_path)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys = ON")
        return conn

    def connect_data(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.business_db_path)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys = ON")
        return conn

    def _initialize(self) -> None:
        config_statements = [
            "CREATE TABLE IF NOT EXISTS data_pages (technical_name TEXT PRIMARY KEY, display_name TEXT NOT NULL, data_role TEXT NOT NULL, current_schema_version TEXT NOT NULL, created_at TEXT NOT NULL, selected_sheet TEXT, primary_key_json TEXT NOT NULL DEFAULT '[]')",
            "CREATE TABLE IF NOT EXISTS data_page_fields (page_name TEXT NOT NULL, technical_name TEXT NOT NULL, display_name TEXT NOT NULL, sqlite_type TEXT NOT NULL, required INTEGER NOT NULL DEFAULT 0, ordinal INTEGER NOT NULL, PRIMARY KEY(page_name, technical_name), FOREIGN KEY(page_name) REFERENCES data_pages(technical_name))",
            "CREATE TABLE IF NOT EXISTS schema_versions (page_name TEXT NOT NULL, version TEXT NOT NULL, definition_json TEXT NOT NULL, confirmed_at TEXT NOT NULL, PRIMARY KEY(page_name, version))",
            "CREATE TABLE IF NOT EXISTS relationships (relationship_id TEXT PRIMARY KEY, source_page TEXT NOT NULL, source_field TEXT NOT NULL, target_page TEXT NOT NULL, target_field TEXT NOT NULL, cardinality TEXT NOT NULL, confidence TEXT NOT NULL, confirmed_at TEXT)",
            "CREATE TABLE IF NOT EXISTS calculation_models (version TEXT PRIMARY KEY, status TEXT NOT NULL, manifest_json TEXT NOT NULL, rules_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, published_at TEXT)",
            "CREATE TABLE IF NOT EXISTS output_schemas (schema_name TEXT PRIMARY KEY, fields_json TEXT NOT NULL, excel_headers_json TEXT NOT NULL, version INTEGER NOT NULL, saved_at TEXT NOT NULL)",
            "CREATE TABLE IF NOT EXISTS output_field_rules (field_name TEXT PRIMARY KEY, mode TEXT NOT NULL, source_ref TEXT NOT NULL DEFAULT '', fixed_value TEXT NOT NULL DEFAULT '', description TEXT NOT NULL DEFAULT '', generated_code TEXT NOT NULL DEFAULT '', status TEXT NOT NULL, updated_at TEXT NOT NULL)",
            "CREATE TABLE IF NOT EXISTS temporary_calculation_fields (name TEXT PRIMARY KEY, display_name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', generated_code TEXT NOT NULL DEFAULT '', status TEXT NOT NULL, priority INTEGER NOT NULL DEFAULT 100, updated_at TEXT NOT NULL)",
            "CREATE TABLE IF NOT EXISTS audit_logs (audit_id INTEGER PRIMARY KEY AUTOINCREMENT, event_type TEXT NOT NULL, object_type TEXT NOT NULL, object_id TEXT NOT NULL, payload_json TEXT NOT NULL, created_at TEXT NOT NULL, prev_hash TEXT NOT NULL DEFAULT '', payload_hash TEXT NOT NULL DEFAULT '', entry_hash TEXT NOT NULL DEFAULT '')",
            "CREATE TABLE IF NOT EXISTS data_question_history (question_id TEXT PRIMARY KEY, question TEXT NOT NULL, answer TEXT NOT NULL, result TEXT NOT NULL, references_json TEXT NOT NULL, steps_json TEXT NOT NULL, model_version TEXT NOT NULL, created_at TEXT NOT NULL)",
            "CREATE TABLE IF NOT EXISTS payroll_input_configs (project_id TEXT PRIMARY KEY, display_name TEXT NOT NULL, mapping_json TEXT NOT NULL, sources_json TEXT NOT NULL, updated_at TEXT NOT NULL)",
            "CREATE TABLE IF NOT EXISTS configuration_versions (version_id TEXT PRIMARY KEY, display_name TEXT NOT NULL, snapshot_json TEXT NOT NULL, created_at TEXT NOT NULL, snapshot_hash TEXT NOT NULL DEFAULT '', python_hash TEXT NOT NULL DEFAULT '', integrity_hash TEXT NOT NULL DEFAULT '')",
        ]
        data_statements = [
            "CREATE TABLE IF NOT EXISTS import_batches (batch_id TEXT PRIMARY KEY, page_name TEXT NOT NULL, period TEXT, source_file TEXT NOT NULL, record_count INTEGER NOT NULL, status TEXT NOT NULL, schema_hash TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL)",
            "CREATE TABLE IF NOT EXISTS calculation_runs (run_id TEXT PRIMARY KEY, model_version TEXT NOT NULL, model_version_id TEXT NOT NULL DEFAULT '', period TEXT NOT NULL, status TEXT NOT NULL, input_hash TEXT NOT NULL, result_table TEXT, created_at TEXT NOT NULL, completed_at TEXT)",
        ]
        with self.connect_config() as conn:
            for statement in config_statements:
                conn.execute(statement)
            columns = {row[1] for row in conn.execute("PRAGMA table_info(data_pages)")}
            if "primary_key_json" not in columns:
                conn.execute("ALTER TABLE data_pages ADD COLUMN primary_key_json TEXT NOT NULL DEFAULT '[]'")
            audit_columns = {row[1] for row in conn.execute("PRAGMA table_info(audit_logs)")}
            for name in ("prev_hash", "payload_hash", "entry_hash"):
                if name not in audit_columns:
                    conn.execute(f"ALTER TABLE audit_logs ADD COLUMN {name} TEXT NOT NULL DEFAULT ''")
            if "entry_hash" not in audit_columns or conn.execute("SELECT 1 FROM audit_logs WHERE entry_hash = '' OR entry_hash IS NULL LIMIT 1").fetchone():
                self._backfill_audit_chain(conn)
            version_columns = {row[1] for row in conn.execute("PRAGMA table_info(configuration_versions)")}
            for name in ("snapshot_hash", "python_hash", "integrity_hash"):
                if name not in version_columns:
                    conn.execute(f"ALTER TABLE configuration_versions ADD COLUMN {name} TEXT NOT NULL DEFAULT ''")
            if conn.execute("SELECT 1 FROM configuration_versions WHERE snapshot_hash = '' OR python_hash = '' OR integrity_hash = '' LIMIT 1").fetchone():
                self._backfill_configuration_version_integrity(conn)
            model_columns = {row[1] for row in conn.execute("PRAGMA table_info(calculation_models)")}
            if "rules_json" not in model_columns:
                conn.execute("ALTER TABLE calculation_models ADD COLUMN rules_json TEXT NOT NULL DEFAULT '{}'")
        with self.connect_data() as conn:
            for statement in data_statements:
                conn.execute(statement)
            columns = {row[1] for row in conn.execute("PRAGMA table_info(import_batches)")}
            if "schema_hash" not in columns:
                conn.execute("ALTER TABLE import_batches ADD COLUMN schema_hash TEXT NOT NULL DEFAULT ''")
            run_columns = {row[1] for row in conn.execute("PRAGMA table_info(calculation_runs)")}
            if "model_version_id" not in run_columns:
                conn.execute("ALTER TABLE calculation_runs ADD COLUMN model_version_id TEXT NOT NULL DEFAULT ''")

    def _migrate_legacy_database(self) -> None:
        """首次打开旧组织时拆分 organization.db，并保留可恢复副本。"""
        legacy = self.organization_dir / "organization.db"
        archived = self.databases_dir / "legacy_organization.db"
        marker = self.config_dir / "storage_layout.json"
        if marker.exists():
            return
        if not legacy.exists():
            marker.write_text(json.dumps({"layout_version": 2, "configuration_database": str(self.configuration_db_path), "business_database": str(self.business_db_path), "created_at": datetime.now(timezone.utc).isoformat()}, ensure_ascii=False, indent=2), encoding="utf-8")
            return
        with sqlite3.connect(legacy) as source:
            source.row_factory = sqlite3.Row
            legacy_tables = {row[0] for row in source.execute("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")}
            with self.connect_config() as target:
                self._copy_tables(source, target, [name for name in self.CONFIG_TABLES if name in legacy_tables])
            dynamic_data = sorted(
                name for name in legacy_tables
                if name not in self.CONFIG_TABLES
                and name not in self.DATA_TABLES
                and name.startswith(("data_", "payroll_", "local_calculation_result"))
            )
            with self.connect_data() as target:
                self._copy_tables(source, target, [name for name in self.DATA_TABLES if name in legacy_tables])
                self._copy_tables(source, target, dynamic_data)
        with self.connect_config() as conn:
            if conn.execute("SELECT 1 FROM audit_logs WHERE entry_hash = '' OR entry_hash IS NULL LIMIT 1").fetchone():
                self._backfill_audit_chain(conn)
            if conn.execute("SELECT 1 FROM configuration_versions WHERE snapshot_hash = '' OR python_hash = '' OR integrity_hash = '' LIMIT 1").fetchone():
                self._backfill_configuration_version_integrity(conn)
        self._move_legacy_directory_contents(self.organization_dir / "logic", self.config_dir)
        self._move_legacy_directory_contents(self.organization_dir / "output", self.results_dir)
        self._move_legacy_directory_contents(self.organization_dir / "models", self.models_dir)
        if not archived.exists():
            shutil.move(str(legacy), str(archived))
        marker.write_text(json.dumps({"layout_version": 2, "configuration_database": str(self.configuration_db_path), "business_database": str(self.business_db_path), "legacy_backup": str(archived), "migrated_at": datetime.now(timezone.utc).isoformat()}, ensure_ascii=False, indent=2), encoding="utf-8")

    @staticmethod
    def _copy_tables(source: sqlite3.Connection, target: sqlite3.Connection, table_names: Iterable[str]) -> None:
        for table_name in table_names:
            create_row = source.execute("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?", (table_name,)).fetchone()
            if create_row is None or not create_row[0]:
                continue
            target.execute(create_row[0].replace("CREATE TABLE ", "CREATE TABLE IF NOT EXISTS ", 1))
            columns = [row[1] for row in source.execute(f"PRAGMA table_info({OrganizationDatabase._quote_identifier(table_name)})")]
            if not columns:
                continue
            quoted = ", ".join(OrganizationDatabase._quote_identifier(name) for name in columns)
            placeholders = ", ".join("?" for _ in columns)
            rows = source.execute(f"SELECT {quoted} FROM {OrganizationDatabase._quote_identifier(table_name)}")
            target.executemany(f"INSERT OR REPLACE INTO {OrganizationDatabase._quote_identifier(table_name)} ({quoted}) VALUES ({placeholders})", rows)

    @staticmethod
    def _move_legacy_directory_contents(source_dir: Path, target_dir: Path) -> None:
        if not source_dir.is_dir():
            return
        for source in source_dir.iterdir():
            destination = target_dir / source.name
            if destination.exists():
                continue
            shutil.move(str(source), str(destination))

    @staticmethod
    def _hash_bytes(value: bytes) -> str:
        return hashlib.sha256(value).hexdigest()

    @classmethod
    def _audit_entry_hash(cls, audit_id: int, event_type: str, object_type: str, object_id: str, payload_hash: str, created_at: str, prev_hash: str) -> str:
        canonical = json.dumps({
            "audit_id": audit_id,
            "event_type": event_type,
            "object_type": object_type,
            "object_id": object_id,
            "payload_hash": payload_hash,
            "created_at": created_at,
            "prev_hash": prev_hash,
        }, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
        return cls._hash_bytes(canonical)

    @classmethod
    def _append_audit(cls, conn: sqlite3.Connection, event_type: str, object_type: str, object_id: str, payload: dict, created_at: str) -> None:
        """在当前事务中追加一条链式审计记录，所有写入口都必须经过此处。"""
        payload_json = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        payload_hash = cls._hash_bytes(payload_json.encode("utf-8"))
        previous = conn.execute("SELECT entry_hash FROM audit_logs ORDER BY audit_id DESC LIMIT 1").fetchone()
        prev_hash = str(previous[0] or "") if previous else ""
        cursor = conn.execute(
            "INSERT INTO audit_logs(event_type, object_type, object_id, payload_json, created_at, prev_hash, payload_hash, entry_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (event_type, object_type, object_id, payload_json, created_at, prev_hash, payload_hash, ""),
        )
        audit_id = int(cursor.lastrowid)
        entry_hash = cls._audit_entry_hash(audit_id, event_type, object_type, object_id, payload_hash, created_at, prev_hash)
        conn.execute("UPDATE audit_logs SET entry_hash = ? WHERE audit_id = ?", (entry_hash, audit_id))

    @classmethod
    def _backfill_audit_chain(cls, conn: sqlite3.Connection) -> None:
        previous = ""
        rows = conn.execute("SELECT audit_id, event_type, object_type, object_id, payload_json, created_at FROM audit_logs ORDER BY audit_id").fetchall()
        for row in rows:
            payload_hash = cls._hash_bytes(str(row[4]).encode("utf-8"))
            entry_hash = cls._audit_entry_hash(int(row[0]), row[1], row[2], row[3], payload_hash, row[5], previous)
            conn.execute("UPDATE audit_logs SET prev_hash = ?, payload_hash = ?, entry_hash = ? WHERE audit_id = ?", (previous, payload_hash, entry_hash, row[0]))
            previous = entry_hash

    def verify_audit_chain(self) -> dict[str, object]:
        """校验审计链，不修改数据库。"""
        previous = ""
        checked = 0
        with self.connect_config() as conn:
            rows = conn.execute("SELECT audit_id, event_type, object_type, object_id, payload_json, created_at, prev_hash, payload_hash, entry_hash FROM audit_logs ORDER BY audit_id").fetchall()
        for row in rows:
            checked += 1
            payload_hash = self._hash_bytes(str(row[4]).encode("utf-8"))
            expected = self._audit_entry_hash(int(row[0]), row[1], row[2], row[3], payload_hash, row[5], previous)
            if row[6] != previous or row[7] != payload_hash or row[8] != expected:
                return {"valid": False, "checked_entries": checked, "total_entries": len(rows), "last_hash": previous, "error": f"第 {row[0]} 条审计记录完整性校验失败"}
            previous = expected
        return {"valid": True, "checked_entries": checked, "total_entries": len(rows), "last_hash": previous, "error": ""}

    @classmethod
    def _json_hash(cls, payload: object) -> str:
        encoded = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
        return cls._hash_bytes(encoded)

    @classmethod
    def _directory_fingerprint(cls, directory: Path) -> str:
        digest = hashlib.sha256()
        directory = Path(directory)
        if not directory.exists():
            return digest.hexdigest()
        for path in sorted(item for item in directory.rglob("*") if item.is_file()):
            digest.update(str(path.relative_to(directory)).encode("utf-8"))
            digest.update(path.read_bytes())
        return digest.hexdigest()

    def _backfill_configuration_version_integrity(self, conn: sqlite3.Connection) -> None:
        rows = conn.execute("SELECT version_id, snapshot_json, created_at FROM configuration_versions ORDER BY created_at, version_id").fetchall()
        for row in rows:
            snapshot = json.loads(row[1] or "{}")
            snapshot_hash = self._json_hash(snapshot)
            version_dir = self.packages_dir / "configuration_versions" / row[0] / "python"
            python_hash = self._directory_fingerprint(version_dir if version_dir.exists() else self.python_dir)
            integrity_payload = {"version_id": row[0], "snapshot_hash": snapshot_hash, "python_hash": python_hash, "created_at": row[2]}
            integrity_hash = self._json_hash(integrity_payload)
            conn.execute("UPDATE configuration_versions SET snapshot_hash = ?, python_hash = ?, integrity_hash = ? WHERE version_id = ?", (snapshot_hash, python_hash, integrity_hash, row[0]))

    def write_audit(self, event_type: str, object_type: str, object_id: str, payload: dict, created_at: str | None = None) -> None:
        timestamp = created_at or datetime.now(timezone.utc).isoformat()
        with self.connect_config() as conn:
            conn.execute("BEGIN IMMEDIATE")
            self._append_audit(conn, event_type, object_type, object_id, payload, timestamp)

    def schema_fingerprint(self, page_name: str) -> str:
        with self.connect_config() as conn:
            page = conn.execute("SELECT current_schema_version, selected_sheet, primary_key_json FROM data_pages WHERE technical_name = ?", (page_name,)).fetchone()
            schema = conn.execute("SELECT definition_json FROM schema_versions WHERE page_name = ? ORDER BY confirmed_at DESC LIMIT 1", (page_name,)).fetchone()
        if page is None or schema is None:
            raise ValueError(f"数据表 {page_name} 尚未确认 Schema")
        payload = {"page_name": page_name, "version": page[0], "sheet": page[1], "primary_keys": json.loads(page[2] or "[]"), "definition": json.loads(schema[0] or "{}")}
        encoded = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
        return hashlib.sha256(encoded).hexdigest()

    def build_configuration_snapshot(self) -> dict:
        """导出组织当前已保存的配置元数据，绝不包含导入的业务行数据。"""
        with self.connect() as conn:
            pages = []
            for page in conn.execute("SELECT technical_name, display_name, data_role, current_schema_version, selected_sheet, primary_key_json FROM data_pages ORDER BY display_name"):
                fields = [dict(row) for row in conn.execute("SELECT technical_name, display_name, sqlite_type, required, ordinal FROM data_page_fields WHERE page_name = ? ORDER BY ordinal", (page["technical_name"],))]
                schema_row = conn.execute("SELECT definition_json, confirmed_at FROM schema_versions WHERE page_name = ? ORDER BY confirmed_at DESC LIMIT 1", (page["technical_name"],)).fetchone()
                pages.append({
                    "technical_name": page["technical_name"],
                    "display_name": page["display_name"],
                    "data_role": page["data_role"],
                    "schema_version": page["current_schema_version"],
                    "selected_sheet": page["selected_sheet"],
                    "primary_keys": json.loads(page["primary_key_json"] or "[]"),
                    "fields": fields,
                    "confirmed_schema": json.loads(schema_row["definition_json"] or "{}") if schema_row else {},
                    "confirmed_at": schema_row["confirmed_at"] if schema_row else None,
                })
            output_row = conn.execute("SELECT schema_name, fields_json, excel_headers_json, version, saved_at FROM output_schemas WHERE schema_name = ?", ("local_calculation_result",)).fetchone()
            output_rules = [dict(row) for row in conn.execute("SELECT field_name, mode, source_ref, fixed_value, description, generated_code, status, updated_at FROM output_field_rules ORDER BY field_name")]
            temporary_fields = [dict(row) for row in conn.execute("SELECT name, display_name, description, generated_code, status, priority, updated_at FROM temporary_calculation_fields ORDER BY priority, name")]
            relationships = [dict(row) for row in conn.execute("SELECT relationship_id, source_page, source_field, target_page, target_field, cardinality, confidence, confirmed_at FROM relationships ORDER BY relationship_id")]
            payroll_configs = []
            for row in conn.execute("SELECT project_id, display_name, mapping_json, sources_json, updated_at FROM payroll_input_configs ORDER BY project_id"):
                payroll_configs.append({"project_id": row["project_id"], "display_name": row["display_name"], "mapping": json.loads(row["mapping_json"] or "{}"), "sources": json.loads(row["sources_json"] or "[]"), "updated_at": row["updated_at"]})
        return {
            "package_type": "payroll-configuration-version",
            "package_version": "1.0",
            "exported_at": datetime.now(timezone.utc).isoformat(),
            "input_schemas": pages,
            "output_schema": {
                "schema_name": output_row["schema_name"] if output_row else "local_calculation_result",
                "fields": json.loads(output_row["fields_json"] or "[]") if output_row else [],
                "header_groups": json.loads(output_row["excel_headers_json"] or "[]") if output_row else [],
                "version": output_row["version"] if output_row else 0,
                "saved_at": output_row["saved_at"] if output_row else None,
            },
            "output_field_rules": output_rules,
            "temporary_fields": temporary_fields,
            "relationships": relationships,
            "payroll_input_configs": payroll_configs,
            "global_calculation_logic": self.load_global_logic(),
            "contents": ["输入表结构", "字段映射", "表关系", "输出模板", "输出字段规则", "临时字段及 Python 代码", "全局核算逻辑及 Python 代码"],
        }

    def calculation_configuration_fingerprint(self) -> str:
        """计算当前轻量配置的稳定指纹，不包含导出时间等易变字段。"""
        snapshot = self.build_configuration_snapshot()
        snapshot.pop("exported_at", None)
        snapshot.pop("version_id", None)
        snapshot.pop("display_name", None)
        snapshot.pop("saved_at", None)
        encoded = json.dumps(snapshot, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
        return hashlib.sha256(encoded).hexdigest()

    @staticmethod
    def _calculation_rules_fingerprint(rules: dict) -> str:
        encoded = json.dumps(rules, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
        return hashlib.sha256(encoded).hexdigest()

    def _write_published_model_package(self, model_id: str, rules: dict, rules_json: str, rules_fingerprint: str) -> dict:
        """为已发布模型落盘固定 JSON 与 Python 文件，供正式核算和审计使用。"""
        model_dir = self.models_dir / model_id
        model_dir.mkdir(parents=True, exist_ok=True)
        rules_path = model_dir / "rules.json"
        if rules_path.exists() and rules_path.read_text(encoding="utf-8") != rules_json:
            raise ValueError("同一模型版本的固定规则文件已被修改，请先处理模型包完整性问题")
        if not rules_path.exists():
            rules_path.write_text(rules_json, encoding="utf-8")

        groups = (
            ("statutory", rules.get("statutory") or [], ("project", "logicName", "name", "id"), ("generatedCode", "generated_code")),
            ("global", rules.get("global") or [], ("project", "logicName", "name", "id"), ("generatedCode", "generated_code")),
            ("table", rules.get("table") or [], ("project", "logicName", "name", "id"), ("generatedCode", "generated_code")),
            ("custom", rules.get("custom") or [], ("logicName", "name", "project", "id"), ("generatedCode", "generated_code")),
            ("temporary", rules.get("temporary") or [], ("name", "display_name"), ("generated_code", "generatedCode")),
            ("output", rules.get("output_field_rules") or [], ("field_name", "name"), ("generated_code", "generatedCode")),
        )
        python_dir = model_dir / "python"
        code_index: dict[str, dict[str, str]] = {}
        for category, items, name_keys, code_keys in groups:
            category_dir = python_dir / category
            category_dir.mkdir(parents=True, exist_ok=True)
            for index, item in enumerate(items):
                if not isinstance(item, dict):
                    continue
                code_key = next((key for key in code_keys if str(item.get(key) or "").strip()), "")
                code = str(item.get(code_key) or "").strip() if code_key else ""
                if not code:
                    continue
                raw_name = next((str(item.get(key) or "").strip() for key in name_keys if str(item.get(key) or "").strip()), f"rule_{index + 1}")
                safe_name = re.sub(r"[^a-zA-Z0-9_]+", "_", raw_name).strip("_").lower() or f"rule_{index + 1}"
                path = category_dir / f"{index + 1:03d}_{safe_name}.py"
                code_with_newline = code.rstrip() + "\n"
                if path.exists() and path.read_text(encoding="utf-8") != code_with_newline:
                    raise ValueError(f"已发布模型 Python 文件已被修改：{path.name}")
                if not path.exists():
                    path.write_text(code_with_newline, encoding="utf-8")
                code_index[f"{category}:{index}"] = {
                    "path": str(path.relative_to(model_dir)),
                    "code_key": code_key,
                    "sha256": hashlib.sha256(code_with_newline.encode("utf-8")).hexdigest(),
                }
        python_hash = self._directory_fingerprint(python_dir)
        package_manifest = {
            "package_type": "payroll-published-calculation-model",
            "model_version_id": model_id,
            "rules_fingerprint": rules_fingerprint,
            "python_hash": python_hash,
            "python_files": code_index,
        }
        manifest_path = model_dir / "manifest.json"
        if manifest_path.exists():
            try:
                existing_manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            except json.JSONDecodeError as exc:
                raise ValueError("已发布模型清单损坏，请重新执行逻辑校验") from exc
            if existing_manifest != package_manifest:
                raise ValueError("已发布模型清单或 Python 文件已被修改，请先处理模型包完整性问题")
        else:
            manifest_path.write_text(json.dumps(package_manifest, ensure_ascii=False, indent=2), encoding="utf-8")
        return {"package_path": str(model_dir.relative_to(self.organization_dir)), "python_hash": python_hash, "python_files": code_index}

    def publish_calculation_model(self, *, model_version: str, rules: dict) -> dict:
        """持久化一次通过校验的固定规则集合，作为正式核算唯一执行来源。"""
        normalized_version = str(model_version or "").strip()
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,39}", normalized_version):
            raise ValueError("核算模型版本无效")
        if not isinstance(rules, dict):
            raise ValueError("核算规则集合格式无效")
        # rules_json 是发布边界的关键：AI 返回的候选代码只有在此方法被调用后，
        # 才会成为可供正式核算读取的固定版本；正式核算不会接收浏览器传来的 rules。
        # 输出字段规则也必须进入发布快照；正式运行不能回读后来修改过的当前规则表。
        fixed_rules = dict(rules)
        fixed_rules["output_field_rules"] = [
            {key: value for key, value in item.items() if key != "updated_at"}
            for item in self.list_output_field_rules()
        ]
        rules_json = json.dumps(fixed_rules, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        rules_fingerprint = self._calculation_rules_fingerprint(fixed_rules)
        configuration_fingerprint = self.calculation_configuration_fingerprint()
        model_id = f"{normalized_version}-{rules_fingerprint[:16]}"
        created_at = datetime.now(timezone.utc).isoformat()
        package = self._write_published_model_package(model_id, fixed_rules, rules_json, rules_fingerprint)
        manifest = {
            "model_version": normalized_version,
            "rules_fingerprint": rules_fingerprint,
            "configuration_fingerprint": configuration_fingerprint,
            **package,
        }
        with self.connect_config() as conn:
            conn.execute(
                "INSERT OR REPLACE INTO calculation_models(version, status, manifest_json, rules_json, created_at, published_at) VALUES (?, ?, ?, ?, ?, ?)",
                (model_id, "published", json.dumps(manifest, ensure_ascii=False, sort_keys=True), rules_json, created_at, created_at),
            )
            self._append_audit(conn, "calculation_model_published", "calculation_model", model_id, manifest, created_at)
        return {"model_version_id": model_id, **manifest, "published_at": created_at}

    def load_published_calculation_model(self, model_version_id: str | None) -> dict:
        """读取已发布固定模型；任何缺失或指纹不一致都禁止正式核算。"""
        model_id = str(model_version_id or "").strip()
        if not model_id:
            raise ValueError("尚未锁定已校验的核算模型，请先执行逻辑校验")
        with self.connect_config() as conn:
            row = conn.execute("SELECT status, manifest_json, rules_json FROM calculation_models WHERE version = ?", (model_id,)).fetchone()
        if row is None or row[0] != "published":
            raise ValueError("已校验的核算模型不存在或已失效，请重新执行逻辑校验")
        try:
            manifest = json.loads(row[1] or "{}")
            rules = json.loads(row[2] or "{}")
        except json.JSONDecodeError as exc:
            raise ValueError("已校验的核算模型记录损坏，请重新执行逻辑校验") from exc
        if not isinstance(manifest, dict) or not isinstance(rules, dict) or not rules:
            raise ValueError("已校验的核算模型缺少固定规则，请重新执行逻辑校验")
        if manifest.get("rules_fingerprint") != self._calculation_rules_fingerprint(rules):
            raise ValueError("已发布核算模型的固定规则完整性校验失败，请重新执行逻辑校验")
        package_path = str(manifest.get("package_path") or "").strip()
        package_dir = (self.organization_dir / package_path).resolve() if package_path else None
        models_root = self.models_dir.resolve()
        if package_dir is None or (package_dir != models_root and models_root not in package_dir.parents) or not package_dir.is_dir():
            raise ValueError("已发布核算模型的 Python 文件包不存在，请重新执行逻辑校验")
        package_rules_path = package_dir / "rules.json"
        package_manifest_path = package_dir / "manifest.json"
        if not package_rules_path.exists() or not package_manifest_path.exists():
            raise ValueError("已发布核算模型文件不完整，请重新执行逻辑校验")
        if package_rules_path.read_text(encoding="utf-8") != json.dumps(rules, ensure_ascii=False, sort_keys=True, separators=(",", ":")):
            raise ValueError("已发布核算模型规则文件与配置库不一致，请重新执行逻辑校验")
        try:
            package_manifest = json.loads(package_manifest_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            raise ValueError("已发布核算模型 Python 清单损坏，请重新执行逻辑校验") from exc
        if not isinstance(package_manifest, dict):
            raise ValueError("已发布核算模型 Python 清单格式无效，请重新执行逻辑校验")
        if package_manifest.get("rules_fingerprint") != manifest.get("rules_fingerprint") or package_manifest.get("python_hash") != manifest.get("python_hash"):
            raise ValueError("已发布核算模型 Python 清单与配置库不一致，请重新执行逻辑校验")
        python_dir = package_dir / "python"
        if self._directory_fingerprint(python_dir) != manifest.get("python_hash"):
            raise ValueError("已发布核算模型 Python 文件完整性校验失败，请重新执行逻辑校验")
        # 用模型包中的文件内容覆盖规则快照中的代码字段，确保执行器不使用当前配置表或浏览器内容。
        python_files = package_manifest.get("python_files") or {}
        if not isinstance(python_files, dict):
            raise ValueError("已发布核算模型 Python 文件索引格式无效，请重新执行逻辑校验")
        for location, entry in python_files.items():
            try:
                category, raw_index = location.split(":", 1)
                index = int(raw_index)
                item = rules[category][index]
                code_path = (package_dir / str(entry["path"])).resolve()
                if models_root not in code_path.parents or not code_path.is_file():
                    raise ValueError("模型 Python 文件路径无效")
                code = code_path.read_text(encoding="utf-8")
                if hashlib.sha256(code.encode("utf-8")).hexdigest() != entry.get("sha256"):
                    raise ValueError("模型 Python 文件指纹不一致")
                item[str(entry["code_key"])] = code
            except (KeyError, IndexError, TypeError, ValueError) as exc:
                raise ValueError("已发布核算模型 Python 文件索引无效，请重新执行逻辑校验") from exc
        if manifest.get("configuration_fingerprint") != self.calculation_configuration_fingerprint():
            raise ValueError("核算配置在校验后发生变化，请重新执行逻辑校验")
        return {"model_version_id": model_id, "model_version": str(manifest.get("model_version") or ""), "rules": rules, "manifest": manifest}

    def assert_calculation_model(self, *, model_version_id: str | None, model_version: str) -> dict:
        """兼容旧调用：只验证并返回已发布固定模型，不接收调用方规则。"""
        model = self.load_published_calculation_model(model_version_id)
        if model["model_version"] != str(model_version or ""):
            raise ValueError("核算模型版本已变化，请重新执行逻辑校验")
        return model

    def save_configuration_version(self, display_name: str) -> dict:
        name = str(display_name or "").strip()
        if not name:
            raise ValueError("请填写配置版本名称")
        if len(name) > 120:
            raise ValueError("配置版本名称不能超过 120 个字符")
        created_at = datetime.now(timezone.utc).isoformat()
        version_id = f"CFG-{datetime.now(timezone.utc).strftime('%Y%m%d%H%M%S')}-{uuid.uuid4().hex[:6].upper()}"
        snapshot = self.build_configuration_snapshot()
        snapshot["version_id"] = version_id
        snapshot["display_name"] = name
        snapshot["saved_at"] = created_at
        snapshot_hash = self._json_hash(snapshot)
        python_hash = self._directory_fingerprint(self.python_dir)
        integrity_payload = {"version_id": version_id, "snapshot_hash": snapshot_hash, "python_hash": python_hash, "created_at": created_at}
        integrity_hash = self._json_hash(integrity_payload)
        with self.connect() as conn:
            conn.execute("INSERT INTO configuration_versions(version_id, display_name, snapshot_json, created_at, snapshot_hash, python_hash, integrity_hash) VALUES (?, ?, ?, ?, ?, ?, ?)", (version_id, name, json.dumps(snapshot, ensure_ascii=False), created_at, snapshot_hash, python_hash, integrity_hash))
            self._append_audit(conn, "configuration_version_saved", "configuration_version", version_id, {"display_name": name, **integrity_payload, "integrity_hash": integrity_hash}, created_at)
        version_dir = self.packages_dir / "configuration_versions" / version_id
        version_dir.mkdir(parents=True, exist_ok=False)
        (version_dir / "configuration.json").write_text(json.dumps(snapshot, ensure_ascii=False, indent=2), encoding="utf-8")
        if self.python_dir.exists():
            shutil.copytree(self.python_dir, version_dir / "python", dirs_exist_ok=True)
        (version_dir / "manifest.json").write_text(json.dumps({"package_type": "payroll-configuration-version", **integrity_payload, "integrity_hash": integrity_hash}, ensure_ascii=False, indent=2), encoding="utf-8")
        return {"version_id": version_id, "display_name": name, "created_at": created_at, "package_path": str(version_dir), "summary": self._configuration_version_summary(snapshot)}

    def list_configuration_versions(self) -> list[dict]:
        with self.connect() as conn:
            rows = conn.execute("SELECT version_id, display_name, snapshot_json, created_at, snapshot_hash, python_hash, integrity_hash FROM configuration_versions ORDER BY created_at DESC LIMIT 200").fetchall()
        return [{"version_id": row["version_id"], "display_name": row["display_name"], "created_at": row["created_at"], "snapshot_hash": row["snapshot_hash"], "python_hash": row["python_hash"], "integrity_hash": row["integrity_hash"], "summary": self._configuration_version_summary(json.loads(row["snapshot_json"] or "{}"))} for row in rows]

    def get_configuration_version(self, version_id: str) -> dict:
        with self.connect() as conn:
            row = conn.execute("SELECT version_id, display_name, snapshot_json, created_at, snapshot_hash, python_hash, integrity_hash FROM configuration_versions WHERE version_id = ?", (version_id,)).fetchone()
        if row is None:
            raise ValueError("未找到该配置版本")
        snapshot = json.loads(row["snapshot_json"] or "{}")
        return {"version_id": row["version_id"], "display_name": row["display_name"], "created_at": row["created_at"], "snapshot_hash": row["snapshot_hash"], "python_hash": row["python_hash"], "integrity_hash": row["integrity_hash"], "snapshot": snapshot}

    def export_configuration_version(self, version_id: str) -> Path:
        """导出不含真实业务数据的配置版本 ZIP，并附带独立 Python 文件。"""
        version = self.get_configuration_version(version_id)
        snapshot = version["snapshot"]
        snapshot_hash = self._json_hash(snapshot)
        if version["snapshot_hash"] and version["snapshot_hash"] != snapshot_hash:
            raise ValueError("配置版本快照完整性校验失败")
        version_dir = self.packages_dir / "configuration_versions" / version_id
        version_dir.mkdir(parents=True, exist_ok=True)
        (version_dir / "configuration.json").write_text(json.dumps(snapshot, ensure_ascii=False, indent=2), encoding="utf-8")
        python_dir = version_dir / "python"
        groups = (
            ("global", snapshot.get("global_calculation_logic") or [], ("project", "logicName", "name", "id"), ("generatedCode", "generated_code")),
            ("temporary", snapshot.get("temporary_fields") or [], ("name",), ("generated_code",)),
            ("output", snapshot.get("output_field_rules") or [], ("field_name",), ("generated_code",)),
        )
        for category, items, name_keys, code_keys in groups:
            category_dir = python_dir / category
            category_dir.mkdir(parents=True, exist_ok=True)
            for index, item in enumerate(items, start=1):
                code = next((str(item.get(key) or "").strip() for key in code_keys if str(item.get(key) or "").strip()), "")
                if not code:
                    continue
                raw_name = next((str(item.get(key) or "").strip() for key in name_keys if str(item.get(key) or "").strip()), f"rule_{index}")
                safe_name = re.sub(r"[^a-zA-Z0-9_]+", "_", raw_name).strip("_").lower() or f"rule_{index}"
                (category_dir / f"{safe_name}.py").write_text(code.rstrip() + "\n", encoding="utf-8")
        python_hash = self._directory_fingerprint(python_dir)
        if version["python_hash"] and version["python_hash"] != python_hash:
            raise ValueError("配置版本 Python 代码完整性校验失败")
        integrity_payload = {"version_id": version_id, "snapshot_hash": snapshot_hash, "python_hash": python_hash, "created_at": version["created_at"]}
        integrity_hash = self._json_hash(integrity_payload)
        if version["integrity_hash"] and version["integrity_hash"] != integrity_hash:
            raise ValueError("配置版本清单完整性校验失败")
        (version_dir / "manifest.json").write_text(json.dumps({"package_type": "payroll-configuration-version", **integrity_payload, "integrity_hash": integrity_hash}, ensure_ascii=False, indent=2), encoding="utf-8")
        archive_base = self.packages_dir / "configuration_versions" / version_id
        return Path(shutil.make_archive(str(archive_base), "zip", root_dir=version_dir))

    def import_configuration_version(self, archive_path: Path) -> dict:
        """校验并导入配置版本 ZIP；只覆盖配置，不覆盖业务明细。"""
        archive_path = Path(archive_path)
        if not archive_path.is_file() or archive_path.stat().st_size <= 0:
            raise ValueError("配置版本 ZIP 文件不存在或为空")
        with tempfile.TemporaryDirectory(prefix="payroll-config-import-") as temporary_dir:
            extract_dir = Path(temporary_dir) / "package"
            extract_dir.mkdir()
            try:
                with zipfile.ZipFile(archive_path) as archive:
                    members = archive.infolist()
                    if len(members) > 256:
                        raise ValueError("配置版本包文件数量超过允许范围")
                    for member in members:
                        member_path = Path(member.filename)
                        if member.is_dir() or member.filename.endswith("/"):
                            continue
                        if member_path.is_absolute() or ".." in member_path.parts:
                            raise ValueError("配置版本包包含不安全的文件路径")
                        target = (extract_dir / member_path).resolve()
                        if extract_dir.resolve() not in target.parents:
                            raise ValueError("配置版本包包含越界文件路径")
                        if member.file_size > 8 * 1024 * 1024:
                            raise ValueError("配置版本包中的单个文件不能超过 8 MB")
                        target.parent.mkdir(parents=True, exist_ok=True)
                        with archive.open(member) as source, target.open("wb") as destination:
                            shutil.copyfileobj(source, destination, length=1024 * 1024)
            except zipfile.BadZipFile as exc:
                raise ValueError("配置版本文件不是合法 ZIP") from exc

            configuration_path = extract_dir / "configuration.json"
            manifest_path = extract_dir / "manifest.json"
            if not configuration_path.is_file() or not manifest_path.is_file():
                raise ValueError("配置版本包缺少 configuration.json 或 manifest.json")
            try:
                snapshot = json.loads(configuration_path.read_text(encoding="utf-8"))
                manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError) as exc:
                raise ValueError("配置版本包中的 JSON 文件格式无效") from exc
            if not isinstance(snapshot, dict) or not isinstance(manifest, dict):
                raise ValueError("配置版本包的 JSON 根节点必须是对象")
            if manifest.get("package_type") != "payroll-configuration-version" or snapshot.get("package_type") != "payroll-configuration-version":
                raise ValueError("配置版本包类型不正确")
            version_id = str(snapshot.get("version_id") or "").strip()
            display_name = str(snapshot.get("display_name") or "").strip()
            created_at = str(snapshot.get("saved_at") or "").strip() or datetime.now(timezone.utc).isoformat()
            if not re.fullmatch(r"CFG-[0-9]{14}-[A-F0-9]{6}", version_id):
                raise ValueError("配置版本编号格式无效")
            if not display_name:
                raise ValueError("配置版本名称不能为空")

            snapshot_hash = self._json_hash(snapshot)
            python_dir = extract_dir / "python"
            python_hash = self._directory_fingerprint(python_dir if python_dir.exists() else extract_dir / "_empty_python")
            expected_snapshot_hash = str(manifest.get("snapshot_hash") or "")
            expected_python_hash = str(manifest.get("python_hash") or "")
            if expected_snapshot_hash and expected_snapshot_hash != snapshot_hash:
                raise ValueError("配置版本快照完整性校验失败：configuration.json 已被修改")
            if expected_python_hash and expected_python_hash != python_hash:
                raise ValueError("配置版本 Python 文件完整性校验失败：代码文件与清单不一致")
            integrity_payload = {"version_id": version_id, "snapshot_hash": snapshot_hash, "python_hash": python_hash, "created_at": str(manifest.get("created_at") or created_at)}
            expected_integrity = str(manifest.get("integrity_hash") or "")
            if expected_integrity and expected_integrity != self._json_hash(integrity_payload):
                raise ValueError("配置版本清单完整性校验失败")

            normalized = self._validate_import_snapshot(snapshot)
            # 备份当前配置文件；数据库事务和文件恢复共同保证失败不改变现状。
            with tempfile.TemporaryDirectory(prefix="payroll-config-backup-") as backup_dir_name:
                backup_dir = Path(backup_dir_name)
                database_backup = backup_dir / "configuration.db"
                shutil.copy2(self.configuration_db_path, database_backup)
                global_backup = backup_dir / "global_calculation_logic.json"
                if self.global_logic_path.exists():
                    shutil.copy2(self.global_logic_path, global_backup)
                python_backup = backup_dir / "python"
                if self.python_dir.exists():
                    shutil.copytree(self.python_dir, python_backup)
                try:
                    self._apply_import_snapshot(snapshot, normalized, version_id, display_name, created_at, snapshot_hash, python_hash, integrity_payload)
                    self.global_logic_path.write_text(json.dumps({"version": 1, "scope": "organization_global", "rules": snapshot.get("global_calculation_logic") or [], "updated_at": datetime.now(timezone.utc).isoformat()}, ensure_ascii=False, indent=2), encoding="utf-8")
                    shutil.rmtree(self.python_dir, ignore_errors=True)
                    self.python_dir.mkdir(parents=True, exist_ok=True)
                    self._sync_python_rules("global", snapshot.get("global_calculation_logic") or [], name_keys=("project", "logicName", "name", "id"), code_keys=("generatedCode", "generated_code"))
                    self._sync_python_rules("temporary", normalized["temporary_fields"], name_keys=("name",), code_keys=("generated_code",))
                    self._sync_python_rules("output", normalized["output_rules"], name_keys=("field_name",), code_keys=("generated_code",))
                except Exception:
                    shutil.copy2(database_backup, self.configuration_db_path)
                    if global_backup.exists():
                        shutil.copy2(global_backup, self.global_logic_path)
                    else:
                        self.global_logic_path.unlink(missing_ok=True)
                    shutil.rmtree(self.python_dir, ignore_errors=True)
                    if python_backup.exists():
                        shutil.copytree(python_backup, self.python_dir)
                    raise
            return {"version_id": version_id, "display_name": display_name, "created_at": created_at, "summary": self._configuration_version_summary(snapshot), "business_data_preserved": True}

    def _validate_import_snapshot(self, snapshot: dict) -> dict:
        """只做无副作用校验，并返回可直接写入的规范化配置。"""
        pages = snapshot.get("input_schemas")
        if not isinstance(pages, list):
            raise ValueError("配置版本缺少有效的输入表结构")
        page_names: set[str] = set()
        page_fields: dict[str, set[str]] = {}
        for page in pages:
            if not isinstance(page, dict):
                raise ValueError("输入表结构中存在无效项目")
            page_name = str(page.get("technical_name") or "").strip()
            self._validate_identifier(page_name)
            if page_name in page_names:
                raise ValueError(f"输入表结构重复：{page_name}")
            page_names.add(page_name)
            fields = page.get("fields")
            if not isinstance(fields, list) or not fields:
                raise ValueError(f"输入表 {page_name} 缺少字段")
            names: set[str] = set()
            for index, field in enumerate(fields):
                if not isinstance(field, dict):
                    raise ValueError(f"输入表 {page_name} 的第 {index + 1} 个字段无效")
                normalized_field = self._normalize_field(field, index)
                if normalized_field["technical_name"] in names:
                    raise ValueError(f"输入表 {page_name} 存在重复字段：{normalized_field['technical_name']}")
                names.add(normalized_field["technical_name"])
            primary_keys = page.get("primary_keys") or []
            if not isinstance(primary_keys, list) or len(primary_keys) != 1 or primary_keys[0] not in names:
                raise ValueError(f"输入表 {page_name} 的主键配置无效")
            page_fields[page_name] = names

        output_schema = snapshot.get("output_schema") or {}
        if not isinstance(output_schema, dict):
            raise ValueError("输出模板结构无效")
        output_fields = output_schema.get("fields") or []
        if not isinstance(output_fields, list):
            raise ValueError("输出模板结构无效")
        output_names: set[str] = set()
        normalized_output = []
        for field in output_fields:
            normalized_field = self._normalize_output_field(field)
            if normalized_field["name"] in output_names:
                raise ValueError(f"输出模板存在重复字段：{normalized_field['name']}")
            output_names.add(normalized_field["name"])
            normalized_output.append(normalized_field)

        temporary_fields = snapshot.get("temporary_fields") or []
        if not isinstance(temporary_fields, list):
            raise ValueError("临时字段配置无效")
        temporary_names: set[str] = set()
        normalized_temporary = []
        for field in temporary_fields:
            if not isinstance(field, dict):
                raise ValueError("临时字段中存在无效项目")
            name = str(field.get("name") or "").strip()
            self._validate_identifier(name)
            if name in temporary_names:
                raise ValueError(f"临时字段名称重复：{name}")
            temporary_names.add(name)
            code = str(field.get("generated_code") or "")
            if code:
                validate_rule_code(code, f"临时字段：{name}")
            normalized_temporary.append({"name": name, "display_name": str(field.get("display_name") or name), "description": str(field.get("description") or ""), "generated_code": code, "status": str(field.get("status") or "待配置"), "priority": max(1, int(field.get("priority") or 100))})
        self._validate_temp_dependencies(normalized_temporary, temporary_names)

        rules = snapshot.get("output_field_rules") or []
        if not isinstance(rules, list):
            raise ValueError("输出字段规则配置无效")
        normalized_rules = []
        rule_names: set[str] = set()
        for rule in rules:
            if not isinstance(rule, dict):
                raise ValueError("输出字段规则中存在无效项目")
            field_name = str(rule.get("field_name") or "").strip()
            self._validate_identifier(field_name)
            if field_name not in output_names:
                raise ValueError(f"输出字段规则引用了不存在的模板字段：{field_name}")
            if field_name in rule_names:
                raise ValueError(f"输出字段规则重复：{field_name}")
            rule_names.add(field_name)
            mode = str(rule.get("mode") or "").strip()
            if mode not in {"source", "formula", "fixed"}:
                raise ValueError(f"输出字段 {field_name} 的取值方式无效")
            source_ref = str(rule.get("source_ref") or "").strip()
            if mode == "source" and source_ref:
                match = re.fullmatch(r"([a-z][a-z0-9_]{0,62})\.([a-z][a-z0-9_]{0,62})", source_ref)
                if not match or (match.group(1) not in page_fields and match.group(1) != "output"):
                    raise ValueError(f"输出字段 {field_name} 的数据来源无效：{source_ref}")
                if match.group(1) != "output" and match.group(2) not in page_fields[match.group(1)]:
                    raise ValueError(f"输出字段 {field_name} 的数据来源字段不存在：{source_ref}")
            code = str(rule.get("generated_code") or "")
            if code:
                validate_rule_code(code, f"输出字段：{field_name}")
            normalized_rules.append({"field_name": field_name, "mode": mode, "source_ref": source_ref, "fixed_value": str(rule.get("fixed_value") or ""), "description": str(rule.get("description") or ""), "generated_code": code, "status": str(rule.get("status") or "待配置")})
        self._validate_snapshot_output_dependencies(normalized_rules, output_names)
        return {"pages": pages, "output_fields": normalized_output, "temporary_fields": normalized_temporary, "output_rules": normalized_rules}

    def _validate_temp_dependencies(self, fields: list[dict], names: set[str]) -> None:
        dependencies = {item["name"]: re.findall(r"@temp\.([a-z][a-z0-9_]*)", item.get("description", ""), re.IGNORECASE) for item in fields}
        for name, refs in dependencies.items():
            unknown = sorted(set(refs) - names)
            if unknown:
                raise ValueError(f"临时字段 {name} 引用了不存在的临时字段：{', '.join(unknown)}")
        self._assert_acyclic(dependencies, "临时字段计算逻辑")

    @staticmethod
    def _assert_acyclic(dependencies: dict[str, list[str]], label: str) -> None:
        visiting: list[str] = []
        visited: set[str] = set()
        def visit(name: str) -> None:
            if name in visiting:
                start = visiting.index(name)
                raise ValueError(f"{label}存在循环引用：{' -> '.join([*visiting[start:], name])}")
            if name in visited:
                return
            visiting.append(name)
            for dependency in dependencies.get(name, []):
                visit(dependency)
            visiting.pop()
            visited.add(name)
        for name in dependencies:
            visit(name)

    def _validate_snapshot_output_dependencies(self, rules: list[dict], output_names: set[str]) -> None:
        rule_names = {item["field_name"] for item in rules}
        dependencies: dict[str, list[str]] = {}
        for rule in rules:
            refs = []
            if rule["mode"] == "source" and rule["source_ref"].startswith("output."):
                refs.append(rule["source_ref"][len("output."):])
            if rule["mode"] == "formula":
                refs.extend(re.findall(r"@output\.([a-z][a-z0-9_]*)", rule["description"], re.IGNORECASE))
            unknown = sorted(set(refs) - output_names)
            if unknown:
                raise ValueError(f"输出字段 {rule['field_name']} 引用了不存在的输出字段：{', '.join(unknown)}")
            dependencies[rule["field_name"]] = [ref for ref in refs if ref in rule_names]
        self._assert_acyclic(dependencies, "输出字段计算逻辑")

    def _apply_import_snapshot(self, snapshot: dict, normalized: dict, version_id: str, display_name: str, created_at: str, snapshot_hash: str, python_hash: str, integrity_payload: dict) -> None:
        now = datetime.now(timezone.utc).isoformat()
        with self.connect_config() as conn:
            conn.execute("BEGIN IMMEDIATE")
            for table in ("data_page_fields", "schema_versions", "relationships", "output_field_rules", "temporary_calculation_fields", "payroll_input_configs", "calculation_models", "output_schemas", "data_pages"):
                conn.execute(f"DELETE FROM {table}")
            for page in normalized["pages"]:
                page_name = page["technical_name"]
                schema_version = str(page.get("schema_version") or "1")
                fields = [self._normalize_field(field, index) for index, field in enumerate(page["fields"])]
                conn.execute("INSERT INTO data_pages(technical_name, display_name, data_role, current_schema_version, created_at, selected_sheet, primary_key_json) VALUES (?, ?, ?, ?, ?, ?, ?)", (page_name, str(page.get("display_name") or page_name), str(page.get("data_role") or "input"), schema_version, str(page.get("created_at") or now), page.get("selected_sheet"), json.dumps(page.get("primary_keys") or [], ensure_ascii=False)))
                conn.executemany("INSERT INTO data_page_fields(page_name, technical_name, display_name, sqlite_type, required, ordinal) VALUES (?, ?, ?, ?, ?, ?)", [(page_name, field["technical_name"], field["display_name"], field["sqlite_type"], int(field["required"]), field["ordinal"]) for field in fields])
                conn.execute("INSERT INTO schema_versions(page_name, version, definition_json, confirmed_at) VALUES (?, ?, ?, ?)", (page_name, schema_version, json.dumps(page.get("confirmed_schema") or {}, ensure_ascii=False), str(page.get("confirmed_at") or now)))
            output_schema = snapshot.get("output_schema") or {}
            conn.execute("INSERT INTO output_schemas(schema_name, fields_json, excel_headers_json, version, saved_at) VALUES (?, ?, ?, ?, ?)", (str(output_schema.get("schema_name") or "local_calculation_result"), json.dumps(normalized["output_fields"], ensure_ascii=False), json.dumps(output_schema.get("header_groups") or [], ensure_ascii=False), int(output_schema.get("version") or 1), str(output_schema.get("saved_at") or now)))
            conn.executemany("INSERT INTO temporary_calculation_fields(name, display_name, description, generated_code, status, priority, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)", [(item["name"], item["display_name"], item["description"], item["generated_code"], item["status"], item["priority"], now) for item in normalized["temporary_fields"]])
            conn.executemany("INSERT INTO output_field_rules(field_name, mode, source_ref, fixed_value, description, generated_code, status, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", [(item["field_name"], item["mode"], item["source_ref"], item["fixed_value"], item["description"], item["generated_code"], item["status"], now) for item in normalized["output_rules"]])
            for item in snapshot.get("relationships") or []:
                conn.execute("INSERT INTO relationships(relationship_id, source_page, source_field, target_page, target_field, cardinality, confidence, confirmed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", tuple(item.get(key) for key in ("relationship_id", "source_page", "source_field", "target_page", "target_field", "cardinality", "confidence", "confirmed_at")))
            for item in snapshot.get("payroll_input_configs") or []:
                conn.execute("INSERT INTO payroll_input_configs(project_id, display_name, mapping_json, sources_json, updated_at) VALUES (?, ?, ?, ?, ?)", (item.get("project_id"), item.get("display_name") or item.get("project_id"), json.dumps(item.get("mapping") or {}, ensure_ascii=False), json.dumps(item.get("sources") or [], ensure_ascii=False), item.get("updated_at") or now))
            conn.execute("INSERT OR REPLACE INTO configuration_versions(version_id, display_name, snapshot_json, created_at, snapshot_hash, python_hash, integrity_hash) VALUES (?, ?, ?, ?, ?, ?, ?)", (version_id, display_name, json.dumps(snapshot, ensure_ascii=False), created_at, snapshot_hash, python_hash, self._json_hash(integrity_payload)))
            self._append_audit(conn, "configuration_version_imported", "configuration_version", version_id, {"display_name": display_name, "snapshot_hash": snapshot_hash, "python_hash": python_hash, "business_data_preserved": True}, now)

    @staticmethod
    def _configuration_version_summary(snapshot: dict) -> dict:
        return {
            "input_schema_count": len(snapshot.get("input_schemas") or []),
            "output_field_count": len((snapshot.get("output_schema") or {}).get("fields") or []),
            "output_rule_count": len(snapshot.get("output_field_rules") or []),
            "temporary_field_count": len(snapshot.get("temporary_fields") or []),
            "global_logic_count": len(snapshot.get("global_calculation_logic") or []),
        }

    def save_data_question(self, *, question_id: str, question: str, answer: str, result: str, references: list[str], steps: list[str], model_version: str = "v1.3", created_at: str | None = None) -> dict:
        timestamp = created_at or datetime.now(timezone.utc).isoformat()
        with self.connect() as conn:
            conn.execute("INSERT INTO data_question_history(question_id, question, answer, result, references_json, steps_json, model_version, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", (question_id, question, answer, result, json.dumps(references, ensure_ascii=False), json.dumps(steps, ensure_ascii=False), model_version, timestamp))
        return {"question_id": question_id, "question": question, "answer": answer, "result": result, "references": references, "steps": steps, "model_version": model_version, "created_at": timestamp}

    def list_data_questions(self, *, limit: int = 50) -> list[dict]:
        with self.connect() as conn:
            rows = conn.execute("SELECT question_id, question, answer, result, references_json, steps_json, model_version, created_at FROM data_question_history ORDER BY created_at DESC LIMIT ?", (max(1, min(limit, 200)),)).fetchall()
        return [{"question_id": row[0], "question": row[1], "answer": row[2], "result": row[3], "references": json.loads(row[4]), "steps": json.loads(row[5]), "model_version": row[6], "created_at": row[7]} for row in rows]

    def create_data_page(self, *, display_name: str, technical_name: str, data_role: str, schema_version: str, fields: Iterable[dict], selected_sheet: str | None = None, primary_keys: Iterable[str] = ()) -> None:
        self._validate_identifier(technical_name)
        normalized = [self._normalize_field(field, index) for index, field in enumerate(fields)]
        now = datetime.now(timezone.utc).isoformat()
        primary_keys = list(primary_keys)
        field_names = {field["technical_name"] for field in normalized}
        if len(primary_keys) != 1 or primary_keys[0] not in field_names:
            raise ValueError("每张数据表必须选择一个有效的主键字段")
        with self.connect_config() as config_conn:
            config_conn.execute("BEGIN")
            config_conn.execute("INSERT INTO data_pages VALUES (?, ?, ?, ?, ?, ?, ?)", (technical_name, display_name, data_role, schema_version, now, selected_sheet, json.dumps(primary_keys, ensure_ascii=False)))
            config_conn.executemany("INSERT INTO data_page_fields VALUES (?, ?, ?, ?, ?, ?)", [(technical_name, field["technical_name"], field["display_name"], field["sqlite_type"], int(field["required"]), field["ordinal"]) for field in normalized])
            self._append_audit(config_conn, "schema_confirmed", "data_page", technical_name, {}, now)

    def prepare_data_table(self, conn: sqlite3.Connection, *, page_name: str, fields: Iterable[dict], rebuild: bool) -> str:
        """仅在真实数据导入时创建或重建物理输入表。"""
        self._validate_identifier(page_name)
        table_name = f"data_{page_name}"
        self._validate_identifier(table_name)
        normalized = [self._normalize_field(field, index) for index, field in enumerate(fields)]
        columns = ["_sys_id INTEGER PRIMARY KEY", "_sys_period TEXT", "_sys_batch_id TEXT NOT NULL", "_sys_imported_at TEXT NOT NULL", "_sys_source_file TEXT NOT NULL"]
        columns.extend(f"{self._quote_identifier(field['technical_name'])} {field['sqlite_type']}" + (" NOT NULL" if field["required"] else "") for field in normalized)
        if rebuild:
            conn.execute(f"DROP TABLE IF EXISTS {self._quote_identifier(table_name)}")
        conn.execute(f"CREATE TABLE IF NOT EXISTS {self._quote_identifier(table_name)} ({', '.join(columns)})")
        return table_name

    def confirm_schema(self, *, page_name: str, version: str, columns: Iterable[dict], selected_sheet: str, primary_keys: Iterable[str]) -> None:
        """保存用户确认后的列映射；此操作只保存结构，不导入业务数据。"""
        if not selected_sheet or not selected_sheet.strip():
            raise ValueError("必须确认一个工作表")
        columns = list(columns)
        primary_keys = list(primary_keys)
        available = {item.get("technical_name") for item in columns}
        if len(primary_keys) != 1 or primary_keys[0] not in available:
            raise ValueError("必须选择一个存在于当前结构中的主键字段")
        definition = {"sheet_name": selected_sheet, "columns": columns, "primary_keys": primary_keys}
        now = datetime.now(timezone.utc).isoformat()
        with self.connect() as conn:
            page = conn.execute("SELECT technical_name FROM data_pages WHERE technical_name = ?", (page_name,)).fetchone()
            if page is None:
                raise ValueError(f"未找到数据表: {page_name}")
            conn.execute("UPDATE data_pages SET current_schema_version = ?, selected_sheet = ?, primary_key_json = ? WHERE technical_name = ?", (version, selected_sheet, json.dumps(primary_keys, ensure_ascii=False), page_name))
            conn.execute("INSERT OR REPLACE INTO schema_versions(page_name, version, definition_json, confirmed_at) VALUES (?, ?, ?, ?)", (page_name, version, json.dumps(definition, ensure_ascii=False), now))
            self._append_audit(conn, "schema_confirmed", "data_page", page_name, {"version": version, "sheet_name": selected_sheet}, now)

    def update_primary_key(self, *, page_name: str, primary_key: str) -> dict[str, str]:
        """更新已确认数据表的主键选择，并保留审计记录。"""
        primary_key = str(primary_key or "").strip()
        if not primary_key:
            raise ValueError("必须选择一个主键字段")
        now = datetime.now(timezone.utc).isoformat()
        with self.connect() as conn:
            page = conn.execute("SELECT current_schema_version FROM data_pages WHERE technical_name = ?", (page_name,)).fetchone()
            if page is None:
                raise ValueError(f"未找到数据表: {page_name}")
            field = conn.execute("SELECT 1 FROM data_page_fields WHERE page_name = ? AND technical_name = ?", (page_name, primary_key)).fetchone()
            if field is None:
                raise ValueError("主键字段不存在于当前数据表")
            conn.execute("UPDATE data_pages SET primary_key_json = ? WHERE technical_name = ?", (json.dumps([primary_key], ensure_ascii=False), page_name))
            version = page[0] or "v1"
            schema = conn.execute("SELECT definition_json FROM schema_versions WHERE page_name = ? AND version = ?", (page_name, version)).fetchone()
            if schema is not None:
                definition = json.loads(schema[0] or "{}")
                definition["primary_keys"] = [primary_key]
                conn.execute("UPDATE schema_versions SET definition_json = ?, confirmed_at = ? WHERE page_name = ? AND version = ?", (json.dumps(definition, ensure_ascii=False), now, page_name, version))
            self._append_audit(conn, "primary_key_updated", "data_page", page_name, {"primary_key": primary_key}, now)
        return {"page_name": page_name, "primary_key": primary_key}

    def delete_data_page(self, *, page_name: str) -> dict[str, str]:
        """删除当前组织的一张数据页及其物理 SQLite 子表、结构和审计关联。"""
        page_name = str(page_name or "").strip()
        self._validate_identifier(page_name)
        physical_table = f"data_{page_name}"
        self._validate_identifier(physical_table)
        now = datetime.now(timezone.utc).isoformat()
        with self.connect_config() as conn:
            page = conn.execute("SELECT display_name FROM data_pages WHERE technical_name = ?", (page_name,)).fetchone()
            if page is None:
                raise ValueError(f"未找到数据表: {page_name}")
            conn.execute("DELETE FROM data_page_fields WHERE page_name = ?", (page_name,))
            conn.execute("DELETE FROM schema_versions WHERE page_name = ?", (page_name,))
            conn.execute("DELETE FROM data_pages WHERE technical_name = ?", (page_name,))
            self._append_audit(conn, "data_page_deleted", "data_page", page_name, {"display_name": page[0], "physical_table": physical_table}, now)
        with self.connect_data() as conn:
            conn.execute(f"DROP TABLE IF EXISTS {self._quote_identifier(physical_table)}")
            conn.execute("DELETE FROM import_batches WHERE page_name = ?", (page_name,))
        return {"deleted": page_name, "display_name": page[0]}

    def save_output_schema(self, *, schema_name: str, ordered_fields: Iterable[dict], excel_header_groups: Iterable[dict]) -> None:
        """保存结果表字段顺序和 Excel 专用大标题布局。

        ``ordered_fields`` 是最终结果 SQLite 表的字段定义；``excel_header_groups``
        仅保留给导出 Excel 时合并单元格使用，不会创建为 SQLite 字段。
        """
        self._validate_identifier(schema_name)
        fields = list(ordered_fields)
        names = [field.get("name", "") for field in fields]
        if not names or len(names) != len(set(names)):
            raise ValueError("输出字段不能为空且不能重复")
        for name in names:
            self._validate_identifier(name)
        normalized_fields = [self._normalize_output_field(field) for field in fields]
        now = datetime.now(timezone.utc).isoformat()
        with self.connect_config() as conn:
            row = conn.execute("SELECT version FROM output_schemas WHERE schema_name = ?", (schema_name,)).fetchone()
            version = int(row[0]) + 1 if row else 1
            conn.execute("INSERT OR REPLACE INTO output_schemas(schema_name, fields_json, excel_headers_json, version, saved_at) VALUES (?, ?, ?, ?, ?)", (schema_name, json.dumps(normalized_fields, ensure_ascii=False), json.dumps(list(excel_header_groups), ensure_ascii=False), version, now))
            self._append_audit(conn, "output_schema_saved", "output_schema", schema_name, {"version": version, "field_count": len(fields)}, now)

    def prepare_output_table(self, schema_name: str, fields: Iterable[dict]) -> None:
        """仅在正式计算开始时创建结果物理表。"""
        self._validate_identifier(schema_name)
        normalized_fields = [self._normalize_output_field(field) for field in fields]
        with self.connect_data() as conn:
            self._rebuild_output_table(conn, schema_name, normalized_fields)

    def list_output_field_rules(self) -> list[dict]:
        with self.connect() as conn:
            rows = conn.execute("SELECT field_name, mode, source_ref, fixed_value, description, generated_code, status, updated_at FROM output_field_rules ORDER BY field_name").fetchall()
        return [dict(row) for row in rows]

    def list_temporary_calculation_fields(self) -> list[dict]:
        with self.connect() as conn:
            rows = conn.execute("SELECT name, display_name, description, generated_code, status, priority, updated_at FROM temporary_calculation_fields ORDER BY priority, name").fetchall()
        return [dict(row) for row in rows]

    def save_temporary_calculation_fields(self, fields: Iterable[dict]) -> list[dict]:
        normalized: list[dict] = []
        names: set[str] = set()
        for field in fields:
            name = str(field.get("name") or "").strip()
            self._validate_identifier(name)
            if name in names:
                raise ValueError(f"临时字段名称重复: {name}")
            names.add(name)
            display_name = str(field.get("display_name") or name).strip() or name
            description = str(field.get("description") or "")
            generated_code = str(field.get("generated_code") or "")
            status = str(field.get("status") or "待配置").strip() or "待配置"
            priority = max(1, int(field.get("priority") or 100))
            if not description.strip():
                status = "待配置"
                generated_code = ""
            elif status not in {"待解析", "待统一生成", "代码校验未通过", "已解析"}:
                raise ValueError(f"临时字段 {name} 的计算逻辑状态无效")
            elif status == "已解析" and not generated_code:
                raise ValueError(f"临时字段 {name} 的计算逻辑尚未生成并确认")
            # 临时字段只允许依赖临时字段，不允许读取输出字段，避免输出和中间变量形成闭环。
            if re.search(r"@output\\.", description, re.IGNORECASE):
                raise ValueError(f"临时字段 {name} 不能引用 @output 字段；请改为引用输入字段或 @temp 临时字段")
            normalized.append({"name": name, "display_name": display_name, "description": description, "generated_code": generated_code, "status": status, "priority": priority})
        dependencies = {item["name"]: re.findall(r"@temp\\.([a-z][a-z0-9_]*)", item["description"], re.IGNORECASE) for item in normalized}
        for name, refs in dependencies.items():
            unknown = sorted(set(refs) - names)
            if unknown:
                raise ValueError(f"临时字段 {name} 引用了不存在的临时字段: {', '.join(unknown)}")
        visiting: list[str] = []
        visited: set[str] = set()
        def visit(name: str) -> None:
            if name in visiting:
                start = visiting.index(name)
                raise ValueError(f"临时字段计算逻辑存在循环引用: {' -> '.join([*visiting[start:], name])}")
            if name in visited:
                return
            visiting.append(name)
            for dependency in dependencies.get(name, []):
                visit(dependency)
            visiting.pop()
            visited.add(name)
        for name in dependencies:
            visit(name)
        now = datetime.now(timezone.utc).isoformat()
        with self.connect() as conn:
            conn.execute("BEGIN")
            conn.execute("DELETE FROM temporary_calculation_fields")
            conn.executemany(
                "INSERT INTO temporary_calculation_fields(name, display_name, description, generated_code, status, priority, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
                [(item["name"], item["display_name"], item["description"], item["generated_code"], item["status"], item["priority"], now) for item in normalized],
            )
            self._append_audit(conn, "temporary_fields_saved", "calculation_logic", "temporary_fields", {"field_count": len(normalized)}, now)
        self._sync_python_rules("temporary", normalized, name_keys=("name",), code_keys=("generated_code",))
        return [{**item, "updated_at": now} for item in normalized]

    def save_output_field_rules(self, rules: Iterable[dict]) -> list[dict]:
        normalized = []
        for rule in rules:
            field_name = str(rule.get("field_name") or "")
            self._validate_identifier(field_name)
            mode = str(rule.get("mode") or "").strip()
            if mode not in {"source", "formula", "fixed"}:
                raise ValueError(f"输出字段 {field_name} 的取值方式无效")
            source_ref = str(rule.get("source_ref") or "").strip()
            fixed_value = str(rule.get("fixed_value") or "")
            description = str(rule.get("description") or "")
            generated_code = str(rule.get("generated_code") or "")
            status = str(rule.get("status") or "待配置").strip() or "待配置"
            if mode == "source":
                if source_ref and not re.fullmatch(r"[a-z][a-z0-9_]{0,62}\.[a-z][a-z0-9_]{0,62}", source_ref):
                    raise ValueError(f"输出字段 {field_name} 的输入字段格式不正确")
                if not source_ref:
                    status = "待配置"
            elif mode == "fixed":
                if not fixed_value.strip():
                    status = "待配置"
            elif mode == "formula":
                if not description.strip():
                    status = "待配置"
                elif status not in {"待解析", "待统一生成", "代码校验未通过", "已解析"}:
                    raise ValueError(f"输出字段 {field_name} 的计算逻辑状态无效")
                elif status == "已解析" and not generated_code:
                    raise ValueError(f"输出字段 {field_name} 的计算逻辑尚未生成并确认")
            normalized.append({"field_name": field_name, "mode": mode, "source_ref": source_ref, "fixed_value": fixed_value, "description": description, "generated_code": generated_code, "status": status})
        self._validate_output_rule_dependencies(normalized)
        now = datetime.now(timezone.utc).isoformat()
        with self.connect() as conn:
            conn.execute("BEGIN")
            conn.execute("DELETE FROM output_field_rules")
            conn.executemany(
                "INSERT INTO output_field_rules(field_name, mode, source_ref, fixed_value, description, generated_code, status, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                [(item["field_name"], item["mode"], item["source_ref"], item["fixed_value"], item["description"], item["generated_code"], item["status"], now) for item in normalized],
            )
            self._append_audit(conn, "output_field_rules_saved", "output_field_rules", "local_calculation_result", {"field_count": len(normalized)}, now)
        self._sync_python_rules("output", normalized, name_keys=("field_name",), code_keys=("generated_code",))
        return [{**item, "updated_at": now} for item in normalized]

    def _sync_python_rules(self, category: str, items: Iterable[dict], *, name_keys: tuple[str, ...], code_keys: tuple[str, ...]) -> None:
        """将数据库中的已确认 Python 代码同步到组织专属分类目录。"""
        category_dir = self.python_dir / category
        category_dir.mkdir(parents=True, exist_ok=True)
        expected: set[Path] = set()
        for index, item in enumerate(items, start=1):
            code = next((str(item.get(key) or "").strip() for key in code_keys if str(item.get(key) or "").strip()), "")
            if not code:
                continue
            raw_name = next((str(item.get(key) or "").strip() for key in name_keys if str(item.get(key) or "").strip()), f"rule_{index}")
            safe_name = re.sub(r"[^a-zA-Z0-9_]+", "_", raw_name).strip("_").lower() or f"rule_{index}"
            path = category_dir / f"{safe_name}.py"
            temporary = path.with_suffix(".py.tmp")
            temporary.write_text(code.rstrip() + "\n", encoding="utf-8")
            temporary.replace(path)
            expected.add(path)
        for stale in category_dir.glob("*.py"):
            if stale not in expected:
                stale.unlink()

    def _validate_output_rule_dependencies(self, rules: list[dict]) -> None:
        """保存输出字段规则前，拒绝未知输出引用和直接或间接循环引用。"""
        with self.connect() as conn:
            row = conn.execute("SELECT fields_json FROM output_schemas WHERE schema_name = ?", ("local_calculation_result",)).fetchone()
        try:
            schema_fields = json.loads(row[0]) if row else []
        except (TypeError, json.JSONDecodeError) as exc:
            raise ValueError("已保存的输出模板格式无效，无法检查字段依赖") from exc
        field_names = {str(field.get("name")) for field in schema_fields if isinstance(field, dict) and field.get("name")}
        field_names.update(str(rule.get("field_name")) for rule in rules if rule.get("field_name"))
        rule_map = {str(rule.get("field_name")): rule for rule in rules}
        dependencies: dict[str, list[str]] = {}
        for field_name, rule in rule_map.items():
            refs: list[str] = []
            if rule.get("mode") == "source" and str(rule.get("source_ref") or "").startswith("output."):
                refs.append(str(rule["source_ref"])[len("output."):])
            elif rule.get("mode") == "formula":
                refs.extend(re.findall(r"@output\.([a-z][a-z0-9_]*)", str(rule.get("description") or ""), re.IGNORECASE))
            unknown = sorted({ref for ref in refs if ref not in field_names})
            if unknown:
                raise ValueError(f"输出字段 {field_name} 引用了不存在的输出字段: {', '.join(unknown)}")
            dependencies[field_name] = [ref for ref in refs if ref in rule_map]

        visiting: list[str] = []
        visited: set[str] = set()

        def visit(field_name: str) -> None:
            if field_name in visiting:
                start = visiting.index(field_name)
                raise ValueError(f"输出字段计算逻辑存在循环引用: {' -> '.join([*visiting[start:], field_name])}")
            if field_name in visited:
                return
            visiting.append(field_name)
            for dependency in dependencies.get(field_name, []):
                visit(dependency)
            visiting.pop()
            visited.add(field_name)

        for field_name in rule_map:
            visit(field_name)

    @staticmethod
    def _normalize_output_field(field: dict) -> dict:
        name = field.get("name") or field.get("technical_name")
        sqlite_type = (field.get("sqlite_type") or field.get("type") or "TEXT").upper()
        if not name or not _IDENTIFIER.fullmatch(name):
            raise ValueError(f"输出字段名不合法: {name}")
        if sqlite_type not in _SQL_TYPES:
            raise ValueError(f"不支持的输出字段类型: {sqlite_type}")
        return {"name": name, "sqlite_type": sqlite_type, "display_name": field.get("display_name") or field.get("label") or name, "source": field.get("source") or ""}

    def _rebuild_output_table(self, conn: sqlite3.Connection, table_name: str, fields: list[dict]) -> None:
        desired = [("_sys_run_id", "TEXT"), ("_sys_period", "TEXT"), ("_sys_calculated_at", "TEXT")] + [(field["name"], field["sqlite_type"]) for field in fields]
        quoted_table = self._quote_identifier(table_name)
        existing = {row[1] for row in conn.execute(f"PRAGMA table_info({quoted_table})")}
        temp_name = f"_tmp_{table_name}"
        quoted_temp = self._quote_identifier(temp_name)
        column_sql = ", ".join(f"{self._quote_identifier(name)} {sqlite_type}" for name, sqlite_type in desired)
        conn.execute(f"DROP TABLE IF EXISTS {quoted_temp}")
        conn.execute(f"CREATE TABLE {quoted_temp} ({column_sql})")
        copy_columns = [name for name, _ in desired if name in existing]
        if existing and copy_columns:
            columns = ", ".join(self._quote_identifier(name) for name in copy_columns)
            conn.execute(f"INSERT INTO {quoted_temp} ({columns}) SELECT {columns} FROM {quoted_table}")
            conn.execute(f"DROP TABLE {quoted_table}")
        elif existing:
            conn.execute(f"DROP TABLE {quoted_table}")
        conn.execute(f"ALTER TABLE {quoted_temp} RENAME TO {self._quote_identifier(table_name)}")

    @staticmethod
    def _quote_identifier(identifier: str) -> str:
        # 业务字段必须以小写字母开头；结果表还会固定保留以下划线开头的
        # 系统字段（_sys_*），临时重建表使用 _tmp_*。这两类字段都由程序
        # 内部生成，不接受用户任意传入，因此可以安全地纳入白名单。
        if not (_IDENTIFIER.fullmatch(identifier) or _SYSTEM_IDENTIFIER.fullmatch(identifier) or re.fullmatch(r"_tmp_[a-z][a-z0-9_]{0,62}", identifier)):
            raise ValueError(f"数据库标识符不合法: {identifier}")
        return '"' + identifier + '"'

    def _normalize_field(self, field: dict, ordinal: int) -> dict:
        technical_name = field["technical_name"]
        self._validate_identifier(technical_name)
        sqlite_type = field.get("sqlite_type", "TEXT").upper()
        if sqlite_type not in _SQL_TYPES:
            raise ValueError(f"不支持的 SQLite 类型: {sqlite_type}")
        return {"technical_name": technical_name, "display_name": field["display_name"], "sqlite_type": sqlite_type, "required": bool(field.get("required")), "ordinal": ordinal}

    @staticmethod
    def _validate_identifier(identifier: str) -> None:
        if not _IDENTIFIER.fullmatch(identifier):
            raise ValueError("技术名称必须为小写字母开头的 snake_case，且不能包含空格或 SQL 片段")
