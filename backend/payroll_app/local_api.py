"""给 Vite 本地页面使用的最小 Python API 服务。"""

from __future__ import annotations

import json
import uuid
import tempfile
import shutil
import sqlite3
import re
import socket
import threading
from functools import wraps
from urllib.parse import parse_qs, quote, urlparse
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .ai_settings import AISettingsStore, CompatibleAIClient
from .ai_logic_advisor import CalculationLogicAdvisor
from .calculation_engine import CalculationEngine
from .data_question_advisor import DataQuestionAdvisor
from .data_importer import DataImporter
from .organization_db import OrganizationDatabase
from .paths import prepare_data_directory
from .registry import OrganizationRegistry
from .runtime_settings import RuntimeSettingsStore
from .safe_python import validate_rule_code


_AI_REPAIR_CONTEXT_FIELDS = {
    "stage",
    "model_version",
    "participating_tables",
    "participating_fields",
    "generated_code",
    "validation_issue_count",
}
_AI_REPAIR_STAGES = {"running", "completed", "validated", "configuration"}
_AI_SENSITIVE_TEXT_PATTERNS = (
    (re.compile(r"\b1[3-9]\d{9}\b"), "[手机号已脱敏]"),
    (re.compile(r"\b\d{15}(?:\d{2}[0-9Xx])?\b"), "[证件号已脱敏]"),
    (re.compile(r"\b\d{12,19}\b"), "[卡号已脱敏]"),
    (re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}"), "[邮箱已脱敏]"),
    (re.compile(r"(?i)((?:应发|实发|工资|薪资|奖金|补贴|扣款|金额)[^\n，,;；:：=]{0,12})(?:￥|¥)?-?\d+(?:\.\d+)?"), r"\1[金额已脱敏]"),
)

MAX_JSON_BODY_BYTES = 2 * 1024 * 1024
JSON_BODY_LIMITS = {
    "/api/settings/ai": 256 * 1024,
    "/api/settings/runtime": 64 * 1024,
    "/api/ai/calculation-logic/generate": 512 * 1024,
    "/api/ai/calculation-logic/generate-batch": 2 * 1024 * 1024,
    "/api/ai/calculation-repair": 128 * 1024,
    "/api/ai/data-question": 128 * 1024,
    "/api/calculation/validate-code": 2 * 1024 * 1024,
    "/api/calculation/run": 2 * 1024 * 1024,
    "/api/calculation/export": 64 * 1024,
    "/api/data/pages": 1 * 1024 * 1024,
    "/api/output/schema": 1 * 1024 * 1024,
    "/api/output/field-rules": 2 * 1024 * 1024,
    "/api/calculation/temporary-fields": 2 * 1024 * 1024,
    "/api/calculation/global-logic": 2 * 1024 * 1024,
    "/api/configuration-versions/import": 64 * 1024 * 1024,
    "/api/payroll/foundation/schema": 1 * 1024 * 1024,
}
MAX_UPLOAD_FIELD_BYTES = 4 * 1024
UPLOAD_CHUNK_BYTES = 64 * 1024
REQUEST_READ_TIMEOUT_SECONDS = 30
MAX_ACTIVE_REQUESTS = 8
REQUEST_GROUP_LIMITS = {"general": 8, "ai": 1, "import": 1, "calculation": 1}


class RequestBodyTooLarge(ValueError):
    """请求体超过接口允许的大小。"""


def limited_request(method):
    """给每个 HTTP 方法增加按用途分类的并发上限。"""

    @wraps(method)
    def wrapped(self, *args, **kwargs):
        group = self._request_group()
        slot = self.server.request_group_slots[group]
        if not slot.acquire(blocking=False):
            self._send(HTTPStatus.TOO_MANY_REQUESTS, {"error": "同类本地任务正在处理，请稍后重试"})
            return
        try:
            return method(self, *args, **kwargs)
        finally:
            slot.release()

    return wrapped


class BoundedThreadingHTTPServer(ThreadingHTTPServer):
    """限制同时处理的连接数，避免无限创建线程。"""

    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, server_address, handler_class, *, max_workers: int = MAX_ACTIVE_REQUESTS):
        self.request_slots = threading.BoundedSemaphore(max_workers)
        self.request_group_slots = {
            name: threading.BoundedSemaphore(limit) for name, limit in REQUEST_GROUP_LIMITS.items()
        }
        super().__init__(server_address, handler_class)

    def process_request(self, request, client_address):
        if not self.request_slots.acquire(blocking=False):
            payload = json.dumps({"error": "本地服务当前任务较多，请稍后重试"}, ensure_ascii=False).encode("utf-8")
            response = (
                b"HTTP/1.1 429 Too Many Requests\r\n"
                b"Content-Type: application/json; charset=utf-8\r\n"
                + f"Content-Length: {len(payload)}\r\nConnection: close\r\n\r\n".encode("ascii")
                + payload
            )
            try:
                request.sendall(response)
            except (OSError, socket.timeout):
                pass
            finally:
                request.close()
            return
        try:
            super().process_request(request, client_address)
        except BaseException:
            self.request_slots.release()
            raise

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            self.request_slots.release()


class _MultipartReader:
    """只在内存中保留边界附近的小块，将文件内容直接写入临时文件。"""

    def __init__(self, stream: Any, content_length: int) -> None:
        self.stream = stream
        self.remaining = content_length
        self.buffer = bytearray()

    def _fill(self) -> bool:
        if self.remaining <= 0:
            return False
        chunk = self.stream.read(min(UPLOAD_CHUNK_BYTES, self.remaining))
        if not chunk:
            raise ValueError("上传请求提前结束")
        self.remaining -= len(chunk)
        self.buffer.extend(chunk)
        return True

    def read_exact(self, size: int) -> bytes:
        while len(self.buffer) < size:
            if not self._fill():
                raise ValueError("上传请求格式不完整")
        result = bytes(self.buffer[:size])
        del self.buffer[:size]
        return result

    def read_line(self, max_bytes: int) -> bytes:
        while True:
            index = self.buffer.find(b"\r\n")
            if index >= 0:
                if index + 2 > max_bytes:
                    raise ValueError("上传请求头过长")
                result = bytes(self.buffer[: index + 2])
                del self.buffer[: index + 2]
                return result
            if len(self.buffer) > max_bytes:
                raise ValueError("上传请求头过长")
            if not self._fill():
                raise ValueError("上传请求格式不完整")

    def copy_part(self, boundary: bytes, target: Any = None, collector: bytearray | None = None, max_bytes: int = MAX_UPLOAD_FIELD_BYTES) -> tuple[bool, int]:
        marker = b"\r\n--" + boundary
        keep = len(marker) - 1
        total = 0

        def emit(data: bytes) -> None:
            nonlocal total
            total += len(data)
            if total > max_bytes:
                raise RequestBodyTooLarge("上传字段超过允许大小")
            if target is not None and data:
                target.write(data)
            if collector is not None and data:
                collector.extend(data)

        while True:
            index = self.buffer.find(marker)
            if index >= 0:
                emit(bytes(self.buffer[:index]))
                del self.buffer[: index + len(marker)]
                suffix = self.read_exact(2)
                if suffix == b"--":
                    if self.remaining or self.buffer:
                        if self.read_exact(2) != b"\r\n":
                            raise ValueError("上传结束边界格式不正确")
                    return True, total
                if suffix == b"\r\n":
                    return False, total
                # 文件正文中理论上也可能出现相同字节序列，但只有后续是 -- 或 CRLF
                # 时才是 multipart 分隔符；否则把已取出的内容还原为正文继续读取。
                emit(marker + suffix)
                continue

            if len(self.buffer) > keep:
                emit(bytes(self.buffer[:-keep]))
                del self.buffer[:-keep]
            if not self._fill():
                raise ValueError("上传文件缺少结束边界")


class LocalAPIHandler(BaseHTTPRequestHandler):
    store: AISettingsStore
    runtime_settings: RuntimeSettingsStore
    registry: OrganizationRegistry
    workspace: Path

    def setup(self) -> None:
        super().setup()
        self.connection.settimeout(REQUEST_READ_TIMEOUT_SECONDS)

    def _request_group(self) -> str:
        path = urlparse(self.path).path
        if path.startswith("/api/ai/") or path.startswith("/api/settings/ai"):
            return "ai"
        if path in {"/api/data/import", "/api/data/inspect"}:
            return "import"
        if path.startswith("/api/calculation") or path == "/api/calculation-runs":
            return "calculation"
        return "general"

    def do_OPTIONS(self) -> None:  # noqa: N802
        self.send_response(HTTPStatus.NO_CONTENT)
        self.send_header("Access-Control-Allow-Origin", "http://127.0.0.1:5173")
        self.send_header("Access-Control-Allow-Methods", "GET, PUT, POST, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Organization-ID")
        self.end_headers()

    @limited_request
    def do_GET(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        if parsed.path == "/api/organizations":
            self._send(HTTPStatus.OK, {"items": self.registry.list()})
            return
        if parsed.path == "/api/audit":
            database = self.database()
            with database.connect_config() as conn:
                rows = [dict(row) for row in conn.execute("SELECT audit_id, event_type, object_type, object_id, payload_json, created_at FROM audit_logs ORDER BY audit_id DESC LIMIT 200")]
            self._send(HTTPStatus.OK, {"items": rows, "integrity": database.verify_audit_chain()})
            return
        if parsed.path == "/api/configuration-versions":
            version_id = parse_qs(parsed.query).get("version_id", [""])[0].strip()
            if version_id:
                try:
                    self._send(HTTPStatus.OK, self.database().get_configuration_version(version_id))
                except ValueError as exc:
                    self._send(HTTPStatus.NOT_FOUND, {"error": str(exc)})
            else:
                self._send(HTTPStatus.OK, {"items": self.database().list_configuration_versions()})
            return
        if parsed.path == "/api/configuration-versions/export":
            version_id = parse_qs(parsed.query).get("version_id", [""])[0].strip()
            if not version_id:
                self._send(HTTPStatus.BAD_REQUEST, {"error": "缺少配置版本标识"})
                return
            try:
                self._send_file(self.database().export_configuration_version(version_id), content_type="application/zip")
            except ValueError as exc:
                self._send(HTTPStatus.NOT_FOUND, {"error": str(exc)})
            return
        if parsed.path == "/api/import-batches":
            with self.database().connect_data() as conn:
                rows = [dict(row) for row in conn.execute("SELECT * FROM import_batches ORDER BY created_at DESC LIMIT 200")]
            self._send(HTTPStatus.OK, {"items": rows})
            return
        if parsed.path == "/api/data/pages":
            database = self.database()
            with database.connect_config() as conn, database.connect_data() as data_conn:
                raw_pages = [dict(row) for row in conn.execute("SELECT technical_name, display_name, data_role, current_schema_version, created_at, selected_sheet, primary_key_json FROM data_pages ORDER BY created_at DESC")]
                pages = []
                # 历史版本曾允许同名表重复创建。页面只展示同一“名称 + Sheet”下最完整的结构，
                # 优先包含 UID/员工编号，再按字段数量和创建时间选择，避免旧的半成品结构遮住正确表。
                grouped = {}
                for page in raw_pages:
                    fields = [dict(row) for row in conn.execute("SELECT technical_name, display_name, sqlite_type, required, ordinal FROM data_page_fields WHERE page_name = ? ORDER BY ordinal", (page["technical_name"],))]
                    has_uid = any(str(field.get("technical_name") or "").lower() == "uid" or str(field.get("display_name") or "").strip().lower() == "uid" for field in fields)
                    key = (page["display_name"], page.get("selected_sheet") or "")
                    candidate = (1 if has_uid else 0, len(fields), page.get("created_at") or "", page, fields)
                    previous = grouped.get(key)
                    if previous is None or candidate[:3] > previous[:3]:
                        grouped[key] = candidate
                for _, (_, _, _, page, fields) in grouped.items():
                    fields = [dict(row) for row in conn.execute("SELECT technical_name, display_name, sqlite_type, required, ordinal FROM data_page_fields WHERE page_name = ? ORDER BY ordinal", (page["technical_name"],))]
                    schema = conn.execute("SELECT definition_json FROM schema_versions WHERE page_name = ? ORDER BY confirmed_at DESC LIMIT 1", (page["technical_name"],)).fetchone()
                    if schema is not None:
                        try:
                            definition = json.loads(schema[0] or "{}")
                        except (TypeError, json.JSONDecodeError):
                            definition = {}
                        by_db = {item.get("technical_name"): item for item in definition.get("columns", []) if isinstance(item, dict)}
                        for field in fields:
                            source = by_db.get(field["technical_name"], {})
                            # display_name 是数据库字段标签；excel_name 才是用户上传文件中的原始表头。
                            # 两者都返回，前端即可在主键下拉框中保留 UID 等原始列名。
                            field["excel_name"] = source.get("excel_name") or field["display_name"]
                    latest = data_conn.execute("SELECT batch_id, source_file, record_count, status, schema_hash, created_at FROM import_batches WHERE page_name = ? ORDER BY created_at DESC LIMIT 1", (page["technical_name"],)).fetchone()
                    page["fields"] = fields
                    page["primary_keys"] = json.loads(page.pop("primary_key_json") or "[]")
                    page["latest_import"] = dict(latest) if latest else None
                    pages.append(page)
            self._send(HTTPStatus.OK, {"items": pages})
            return
        if parsed.path == "/api/payroll/foundation/configs":
            with self.database().connect_config() as conn:
                rows = [dict(row) for row in conn.execute("SELECT project_id, display_name, mapping_json, sources_json, updated_at FROM payroll_input_configs ORDER BY project_id")]
            for row in rows:
                stored_mapping = json.loads(row.pop("mapping_json") or "{}")
                row["mapping"] = stored_mapping.get("refs", stored_mapping) if isinstance(stored_mapping, dict) else {}
                row["mapping_labels"] = stored_mapping.get("labels", {}) if isinstance(stored_mapping, dict) else {}
                row["sources"] = json.loads(row.pop("sources_json") or "[]")
            self._send(HTTPStatus.OK, {"items": rows})
            return
        if parsed.path == "/api/output/schema":
            with self.database().connect_config() as conn:
                row = conn.execute("SELECT schema_name, fields_json, excel_headers_json, version, saved_at FROM output_schemas WHERE schema_name = ?", ("local_calculation_result",)).fetchone()
            if row is None:
                self._send(HTTPStatus.OK, {"schema_name": "local_calculation_result", "fields": [], "header_groups": [], "version": 0})
            else:
                self._send(HTTPStatus.OK, {"schema_name": row[0], "fields": json.loads(row[1] or "[]"), "header_groups": json.loads(row[2] or "[]"), "version": row[3], "saved_at": row[4]})
            return
        if parsed.path == "/api/output/field-rules":
            self._send(HTTPStatus.OK, {"items": self.database().list_output_field_rules()})
            return
        if parsed.path == "/api/calculation/temporary-fields":
            self._send(HTTPStatus.OK, {"items": self.database().list_temporary_calculation_fields()})
            return
        if parsed.path == "/api/calculation/global-logic":
            self._send(HTTPStatus.OK, {"items": self.database().load_global_logic()})
            return
        if parsed.path == "/api/calculation/input-schema":
            with self.database().connect_config() as conn:
                rows = conn.execute(
                    "SELECT p.technical_name AS table_name, p.display_name AS table_label, f.technical_name AS field_name, f.display_name AS field_label, f.sqlite_type FROM data_pages p JOIN data_page_fields f ON f.page_name = p.technical_name ORDER BY p.display_name, f.ordinal"
                ).fetchall()
            self._send(HTTPStatus.OK, {"items": [dict(row) for row in rows]})
            return
        if parsed.path == "/api/calculation-runs":
            with self.database().connect_data() as conn:
                rows = [dict(row) for row in conn.execute("SELECT * FROM calculation_runs ORDER BY created_at DESC LIMIT 200")]
            self._send(HTTPStatus.OK, {"items": rows})
            return
        if self.path == "/api/settings/ai":
            self._send(HTTPStatus.OK, self.store.get())
            return
        if self.path == "/api/settings/runtime":
            self._send(HTTPStatus.OK, self.runtime_settings.get())
            return
        if parsed.path == "/api/ai/data-question/history":
            self._send(HTTPStatus.OK, {"items": self.database().list_data_questions()})
            return
        self._send(HTTPStatus.NOT_FOUND, {"error": "未找到接口"})

    @limited_request
    def do_PUT(self) -> None:  # noqa: N802
        if self.path == "/api/data/pages/primary-key":
            try:
                body = self._body()
                result = self.database().update_primary_key(page_name=body.get("page_name", ""), primary_key=body.get("primary_key", ""))
                self._send(HTTPStatus.OK, result)
            except RequestBodyTooLarge as exc:
                self._send(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, {"error": str(exc)})
            except ValueError as exc:
                self._send(HTTPStatus.BAD_REQUEST, {"error": str(exc)})
            return
        if self.path == "/api/settings/runtime":
            try:
                self._send(HTTPStatus.OK, self.runtime_settings.save(self._body()))
            except RequestBodyTooLarge as exc:
                self._send(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, {"error": str(exc)})
            except ValueError as exc:
                self._send(HTTPStatus.BAD_REQUEST, {"error": str(exc)})
            return
        if self.path != "/api/settings/ai":
            self._send(HTTPStatus.NOT_FOUND, {"error": "未找到接口"})
            return
        try:
            self._send(HTTPStatus.OK, self.store.save(self._body()))
        except RequestBodyTooLarge as exc:
            self._send(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, {"error": str(exc)})
        except ValueError as exc:
            self._send(HTTPStatus.BAD_REQUEST, {"error": str(exc)})

    @limited_request
    def do_DELETE(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        if parsed.path == "/api/data/pages":
            try:
                technical_name = parse_qs(parsed.query).get("technical_name", [""])[0].strip()
                if not technical_name:
                    raise ValueError("缺少数据表技术名称")
                self._send(HTTPStatus.OK, self.database().delete_data_page(page_name=technical_name))
            except ValueError as exc:
                self._send(HTTPStatus.BAD_REQUEST, {"error": str(exc)})
            return
        if parsed.path != "/api/organizations":
            self._send(HTTPStatus.NOT_FOUND, {"error": "未找到接口"})
            return
        try:
            organization_id = parse_qs(parsed.query).get("organization_id", [""])[0]
            self.registry.delete(organization_id)
            self._send(HTTPStatus.OK, {"deleted": organization_id})
        except ValueError as exc:
            self._send(HTTPStatus.BAD_REQUEST, {"error": str(exc)})

    @limited_request
    def do_POST(self) -> None:  # noqa: N802
        try:
            if self.path == "/api/organizations":
                body = self._body()
                organization_id = body.get("organization_id", "").strip()
                display_name = body.get("display_name", "").strip()
                if not display_name:
                    raise ValueError("组织名称不能为空")
                directory = self.registry.create(organization_id, display_name)
                database = OrganizationDatabase(directory)
                self._send(HTTPStatus.CREATED, {"organization_id": organization_id, "display_name": display_name, "storage_path": str(directory), "configuration_database_path": str(database.configuration_db_path), "business_database_path": str(database.business_db_path)})
                return
            if self.path == "/api/organizations/backup":
                organization_id = self.headers.get("X-Organization-ID", "")
                item = next((row for row in self.registry.list() if row["organization_id"] == organization_id), None)
                if item is None:
                    raise ValueError("当前组织不存在")
                source = Path(item["storage_path"])
                database = OrganizationDatabase(source)
                backup_dir = database.packages_dir / "backups"
                backup_dir.mkdir(parents=True, exist_ok=True)
                archive_name = f"{organization_id}_backup_{datetime.now().strftime('%Y%m%d_%H%M%S')}"
                with tempfile.TemporaryDirectory() as temporary_dir:
                    temporary_archive = Path(shutil.make_archive(str(Path(temporary_dir) / archive_name), "zip", root_dir=source))
                    output = backup_dir / temporary_archive.name
                    shutil.move(str(temporary_archive), output)
                self._send_file(output, content_type="application/zip")
                return
            if self.path == "/api/output/schema":
                body = self._body()
                database = self.database()
                database.save_output_schema(schema_name=body.get("schema_name", "local_calculation_result"), ordered_fields=body.get("ordered_fields", []), excel_header_groups=body.get("excel_header_groups", []))
                with database.connect_config() as conn:
                    row = conn.execute("SELECT version, saved_at FROM output_schemas WHERE schema_name = ?", (body.get("schema_name", "local_calculation_result"),)).fetchone()
                self._send(HTTPStatus.OK, {"schema_name": body.get("schema_name", "local_calculation_result"), "version": row[0], "saved_at": row[1], "template_file": body.get("template_file", "")})
                return
            if self.path == "/api/configuration-versions":
                version = self.database().save_configuration_version(self._body().get("display_name", ""))
                self._send(HTTPStatus.CREATED, version)
                return
            if self.path == "/api/configuration-versions/import":
                _fields, temporary, _file_name = self._read_multipart_upload(require_page_name=False)
                try:
                    result = self.database().import_configuration_version(temporary)
                finally:
                    temporary.unlink(missing_ok=True)
                self._send(HTTPStatus.OK, result)
                return
            if self.path == "/api/output/field-rules":
                rules = self.database().save_output_field_rules(self._body().get("rules", []))
                self._send(HTTPStatus.OK, {"items": rules})
                return
            if self.path == "/api/calculation/temporary-fields":
                fields = self.database().save_temporary_calculation_fields(self._body().get("items", []))
                self._send(HTTPStatus.OK, {"items": fields})
                return
            if self.path == "/api/calculation/global-logic":
                rules = self.database().save_global_logic(self._body().get("rules", []))
                self._send(HTTPStatus.OK, {"items": rules})
                return
            if self.path == "/api/data/import":
                fields, temporary, _file_name = self._read_multipart_upload()
                try:
                    result = DataImporter(self.database()).import_file(temporary, page_name=fields["page_name"], sheet_name=fields.get("sheet_name"), period=fields.get("period"), replace_current=fields.get("replace_current", "").lower() in {"1", "true", "yes"})
                finally:
                    temporary.unlink(missing_ok=True)
                self._send(HTTPStatus.OK, result)
                return
            if self.path == "/api/data/inspect":
                fields, temporary, _file_name = self._read_multipart_upload()
                try:
                    result = DataImporter(self.database()).inspect_file(temporary, page_name=fields["page_name"], sheet_name=fields.get("sheet_name"))
                finally:
                    temporary.unlink(missing_ok=True)
                self._send(HTTPStatus.OK, result)
                return
            if self.path == "/api/data/pages":
                body = self._body()
                database = self.database()
                technical_name = str(body.get("technical_name", "")).strip()
                display_name = str(body.get("display_name", "")).strip()
                selected_sheet = str(body.get("selected_sheet", "")).strip()
                fields = body.get("fields") or []
                primary_key = str(body.get("primary_key", "")).strip()
                if not display_name or not technical_name or not selected_sheet or not fields or not primary_key:
                    raise ValueError("创建数据表时必须提供表名、技术名称、Sheet、字段和主键")
                # 创建操作保持幂等：同一组织下同名且同一 Sheet 的数据表只保留一个逻辑表。
                # 之前每次点击都会生成随机 technical_name，导致页面出现多张同名表。
                with database.connect_config() as conn:
                    candidates = conn.execute(
                        "SELECT technical_name, display_name, data_role, current_schema_version, created_at, selected_sheet, primary_key_json FROM data_pages WHERE display_name = ? AND selected_sheet = ? ORDER BY created_at DESC",
                        (display_name, selected_sheet),
                    ).fetchall()
                    existing = None
                    existing_fields = []
                    existing_columns = []
                    for candidate in candidates:
                        candidate_fields = [dict(row) for row in conn.execute("SELECT technical_name, display_name, sqlite_type, required, ordinal FROM data_page_fields WHERE page_name = ? ORDER BY ordinal", (candidate[0],))]
                        candidate_schema = conn.execute("SELECT definition_json FROM schema_versions WHERE page_name = ? ORDER BY confirmed_at DESC LIMIT 1", (candidate[0],)).fetchone()
                        candidate_columns = []
                        if candidate_schema is not None:
                            try:
                                candidate_definition = json.loads(candidate_schema[0] or "{}")
                            except (TypeError, json.JSONDecodeError):
                                candidate_definition = {}
                            candidate_columns = [(item.get("technical_name"), item.get("excel_name")) for item in candidate_definition.get("columns", []) if isinstance(item, dict)]
                        incoming_columns = [(item.get("technical_name"), item.get("excel_name", item.get("display_name"))) for item in fields if isinstance(item, dict)]
                        if candidate_columns == incoming_columns:
                            existing = candidate
                            existing_fields = candidate_fields
                            existing_columns = candidate_columns
                            break
                    if existing is not None:
                        for field in existing_fields:
                            field["excel_name"] = next((excel for technical, excel in existing_columns if technical == field["technical_name"]), field["display_name"])
                        with database.connect_data() as data_conn:
                            latest = data_conn.execute("SELECT batch_id, source_file, record_count, status, schema_hash, created_at FROM import_batches WHERE page_name = ? ORDER BY created_at DESC LIMIT 1", (existing[0],)).fetchone()
                        self._send(HTTPStatus.OK, {
                                "technical_name": existing[0],
                                "display_name": existing[1],
                                "data_role": existing[2],
                                "current_schema_version": existing[3],
                                "created_at": existing[4],
                                "selected_sheet": existing[5],
                                "fields": existing_fields,
                                "primary_key": json.loads(existing[6] or "[]")[0] if json.loads(existing[6] or "[]") else "",
                                "latest_import": dict(latest) if latest else None,
                                "reused": True,
                        })
                        return
                database.create_data_page(
                    display_name=display_name,
                    technical_name=technical_name,
                    data_role=str(body.get("data_role") or "输入子表"),
                    schema_version="v1",
                    fields=fields,
                    selected_sheet=selected_sheet,
                    primary_keys=[primary_key],
                )
                database.confirm_schema(
                    page_name=technical_name,
                    version="v1",
                    columns=fields,
                    selected_sheet=selected_sheet,
                    primary_keys=[primary_key],
                )
                database.write_audit("data_page_created", "data_page", technical_name, {"table_name": technical_name, "display_name": display_name, "source_file": body.get("source_file", ""), "sheet_name": selected_sheet, "field_count": len(fields)})
                self._send(HTTPStatus.CREATED, {"technical_name": technical_name, "display_name": display_name, "selected_sheet": selected_sheet, "fields": fields, "primary_key": primary_key})
                return
            if self.path == "/api/payroll/foundation/schema":
                self._send(HTTPStatus.OK, self._save_payroll_foundation_schema(self._body()))
                return
            if self.path == "/api/settings/ai/test":
                self._send(HTTPStatus.OK, CompatibleAIClient(self.store.get(include_key=True)).test_connection())
            elif self.path == "/api/settings/ai/models/refresh":
                self._send(HTTPStatus.OK, {"models": CompatibleAIClient(self.store.get(include_key=True)).list_models()})
            elif self.path == "/api/ai/calculation-logic/generate":
                advisor = CalculationLogicAdvisor(CompatibleAIClient(self.store.get(include_key=True)))
                self._send(HTTPStatus.OK, advisor.generate(self._body()))
            elif self.path == "/api/ai/calculation-logic/generate-batch":
                advisor = CalculationLogicAdvisor(CompatibleAIClient(self.store.get(include_key=True)))
                self._send(HTTPStatus.OK, advisor.generate_batch(self._body()))
            elif self.path == "/api/ai/calculation-repair":
                body = self._body()
                error_summary = self._sanitize_ai_text(body.get("error_summary"), "报错摘要", 6000)
                request_text = self._sanitize_ai_text(body.get("request"), "修复要求", 2000)
                if not error_summary and not request_text:
                    raise ValueError("请先填写报错信息或修复要求")
                safe_context = self._safe_ai_repair_context(body.get("context"))
                prompt = {
                    "任务": "协助定位并修复本地薪酬核算 Python 运行问题，只提供分析、修改建议或可审核的代码片段，不要执行代码。",
                    "安全边界": [
                        "不得要求或处理真实业务明细、员工姓名、身份证号、金额明细等敏感数据。",
                        "只能基于错误摘要、运行步骤、用户描述和字段/逻辑元数据回答。",
                        "如果信息不足，明确列出需要用户补充的非敏感信息。",
                        "优先给出具体的 Python 修复方向、校验步骤和需要重新运行的动作。",
                    ],
                    "报错摘要": error_summary[:12000],
                    "用户修复要求": request_text[:4000],
                    "上下文": safe_context,
                }
                answer = CompatibleAIClient(self.store.get(include_key=True)).complete([
                    {"role": "system", "content": "你是本地薪酬核算 Python 错误诊断助手，请用中文回答，禁止编造运行结果。"},
                    {"role": "user", "content": json.dumps(prompt, ensure_ascii=False)},
                ])
                self._send(HTTPStatus.OK, {"answer": answer})
            elif self.path == "/api/calculation/validate-code":
                body = self._body()
                issues = []
                for item in body.get("items", []):
                    if not isinstance(item, dict) or not str(item.get("code") or "").strip():
                        continue
                    try:
                        validate_rule_code(str(item["code"]), str(item.get("label") or "未命名规则"))
                    except ValueError as exc:
                        issues.append(str(exc))
                response: dict[str, Any] = {"issues": issues}
                if not issues:
                    response.update(self.database().publish_calculation_model(model_version=str(body.get("model_version") or "v1.3"), rules=body.get("rules") or {}))
                self._send(HTTPStatus.OK, response)
            elif self.path == "/api/ai/data-question":
                body = self._body()
                advisor = DataQuestionAdvisor(CompatibleAIClient(self.store.get(include_key=True)))
                answer = advisor.answer(question=body.get("question", ""), schema=body.get("schema", []), result_context=self._result_context())
                history = self.database().save_data_question(question_id=f"QUESTION-{datetime.now().strftime('%Y%m%d%H%M%S')}-{uuid.uuid4().hex[:6].upper()}", question=body.get("question", "").strip(), answer=answer["answer"], result=answer.get("result", ""), references=answer.get("references", []), steps=answer.get("steps", []))
                self._send(HTTPStatus.OK, history)
            elif self.path == "/api/calculation/run":
                body = self._body()
                if body.get("rules") is not None or body.get("generatedCode") is not None or body.get("generated_code") is not None:
                    raise ValueError("正式核算不接受临时规则或代码，请先执行逻辑校验并使用已发布模型版本")
                result = CalculationEngine(self.database()).run(
                    model_version_id=body.get("model_version_id"),
                    period=body.get("period", ""),
                )
                self._send(HTTPStatus.OK, result)
            elif self.path == "/api/calculation/export":
                body = self._body()
                output = CalculationEngine(self.database()).export(file_name=body.get("file_name"))
                self._send_file(output)
            else:
                self._send(HTTPStatus.NOT_FOUND, {"error": "未找到接口"})
        except RequestBodyTooLarge as exc:
            self._send(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, {"error": str(exc)})
        except (ValueError, RuntimeError) as exc:
            self._send(HTTPStatus.BAD_REQUEST, {"error": str(exc)})
        except Exception as exc:
            # 本地核算服务即使遇到未预料异常也要返回 JSON，避免浏览器只显示 Load failed。
            self._send(HTTPStatus.INTERNAL_SERVER_ERROR, {"error": f"本地核算服务异常：{type(exc).__name__}: {exc}"})

    def _body(self) -> dict[str, Any]:
        try:
            size = int(self.headers.get("Content-Length", "-1"))
        except ValueError as exc:
            raise ValueError("JSON 请求长度不合法") from exc
        limit = JSON_BODY_LIMITS.get(urlparse(self.path).path, MAX_JSON_BODY_BYTES)
        if size < 0:
            raise ValueError("JSON 请求缺少 Content-Length")
        if size > limit:
            raise RequestBodyTooLarge(f"JSON 请求不能超过 {limit // 1024} KB")
        if size == 0:
            raise ValueError("JSON 请求体不能为空")
        payload = bytearray()
        remaining = size
        while remaining:
            chunk = self.rfile.read(min(UPLOAD_CHUNK_BYTES, remaining))
            if not chunk:
                raise ValueError("JSON 请求提前结束")
            payload.extend(chunk)
            remaining -= len(chunk)
        try:
            body = json.loads(bytes(payload).decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise ValueError("JSON 请求格式不正确") from exc
        if not isinstance(body, dict):
            raise ValueError("JSON 请求必须是对象")
        return body

    def _read_multipart_upload(self, *, require_page_name: bool = True) -> tuple[dict[str, str], Path, str]:
        """解析数据导入表单；文件字段始终流式落盘，不接受 Base64 JSON。"""
        content_type = self.headers.get("Content-Type", "")
        if not content_type.lower().startswith("multipart/form-data"):
            raise ValueError("数据文件必须使用 multipart/form-data 上传，不能使用 Base64 JSON")
        boundary_match = re.search(r"boundary=(?:\"([^\"]+)\"|([^;\s]+))", content_type, re.IGNORECASE)
        if not boundary_match:
            raise ValueError("上传请求缺少 multipart boundary")
        boundary_text = boundary_match.group(1) or boundary_match.group(2)
        try:
            boundary = boundary_text.encode("ascii")
        except UnicodeEncodeError as exc:
            raise ValueError("上传 boundary 格式不合法") from exc
        if not 1 <= len(boundary) <= 200 or b"\r" in boundary or b"\n" in boundary:
            raise ValueError("上传 boundary 格式不合法")
        try:
            content_length = int(self.headers.get("Content-Length", "0"))
        except ValueError as exc:
            raise ValueError("上传请求长度不合法") from exc
        if content_length <= 0:
            raise ValueError("上传请求为空")
        max_upload_bytes = self._max_upload_bytes()
        if content_length > max_upload_bytes:
            raise RequestBodyTooLarge(f"上传文件不能超过 {max_upload_bytes // (1024 * 1024)} MB")

        reader = _MultipartReader(self.rfile, content_length)
        first_boundary = b"--" + boundary + b"\r\n"
        if reader.read_line(len(first_boundary) + 2) != first_boundary:
            raise ValueError("上传请求的起始边界不正确")
        fields: dict[str, str] = {}
        temporary: Path | None = None
        file_name = ""
        part_count = 0
        try:
            finished = False
            while not finished:
                part_count += 1
                if part_count > 16:
                    raise ValueError("上传字段数量超过允许范围")
                headers: dict[str, str] = {}
                while True:
                    line = reader.read_line(MAX_UPLOAD_FIELD_BYTES)
                    if line == b"\r\n":
                        break
                    if b":" not in line:
                        raise ValueError("上传字段头格式不正确")
                    key, value = line[:-2].split(b":", 1)
                    headers[key.decode("ascii", errors="ignore").strip().lower()] = value.decode("utf-8", errors="replace").strip()
                disposition = headers.get("content-disposition", "")
                attributes: dict[str, str] = {}
                for part in disposition.split(";")[1:]:
                    key, separator, value = part.strip().partition("=")
                    if separator:
                        attributes[key.strip().lower()] = value.strip().strip('"')
                field_name = attributes.get("name", "")
                if not field_name:
                    raise ValueError("上传字段缺少名称")
                uploaded_name = attributes.get("filename")
                if uploaded_name is not None:
                    if field_name != "file" or temporary is not None or not uploaded_name:
                        raise ValueError("上传请求只能包含一个 file 文件字段")
                    file_name = Path(uploaded_name.replace("\\", "/")).name or "upload.xlsx"
                    suffix = Path(file_name).suffix.lower() or ".xlsx"
                    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as stream:
                        temporary = Path(stream.name)
                        finished, _ = reader.copy_part(boundary, target=stream, max_bytes=max_upload_bytes)
                else:
                    if field_name not in {"page_name", "sheet_name", "period", "replace_current"}:
                        raise ValueError(f"上传字段不允许：{field_name}")
                    value = bytearray()
                    finished, _ = reader.copy_part(boundary, collector=value, max_bytes=MAX_UPLOAD_FIELD_BYTES)
                    fields[field_name] = value.decode("utf-8", errors="replace")
            if reader.remaining or reader.buffer:
                raise ValueError("上传结束边界后仍存在多余数据")
            if temporary is None:
                raise ValueError("上传请求缺少 file 文件字段")
            if require_page_name and ("page_name" not in fields or not fields["page_name"].strip()):
                raise ValueError("缺少目标数据表")
        except Exception:
            if temporary is not None:
                temporary.unlink(missing_ok=True)
            raise
        return fields, temporary, file_name

    def _max_upload_bytes(self) -> int:
        settings = self.runtime_settings.get()
        return int(settings["max_upload_mb"]) * 1024 * 1024

    @staticmethod
    def _sanitize_ai_text(value: Any, label: str, max_length: int) -> str:
        """限制并脱敏发送给外部模型的错误文本和用户描述。

        自由文本不能被当作可信的隐私过滤器，因此这里只允许有限长度，并遮盖
        常见的直接标识符和金额模式；真实业务明细仍不应粘贴到输入框中。
        """
        text = str(value or "").strip()
        if len(text) > max_length:
            raise ValueError(f"{label}不能超过 {max_length} 个字符，请删除业务明细后重试")
        for pattern, replacement in _AI_SENSITIVE_TEXT_PATTERNS:
            text = pattern.sub(replacement, text)
        return text

    @staticmethod
    def _safe_ai_repair_context(value: Any) -> dict[str, Any]:
        """只从请求上下文中提取固定诊断元数据，拒绝未知字段和业务行。"""
        if value in (None, ""):
            return {}
        if not isinstance(value, dict):
            raise ValueError("AI 诊断上下文必须是元数据对象，不能提交业务数据")
        unknown = sorted(set(value) - _AI_REPAIR_CONTEXT_FIELDS)
        if unknown:
            raise ValueError(f"AI 诊断上下文包含不允许的字段：{', '.join(unknown)}")

        stage = str(value.get("stage") or "").strip()
        if stage and stage not in _AI_REPAIR_STAGES:
            raise ValueError("AI 诊断阶段不合法")
        model_version = str(value.get("model_version") or "").strip()
        if model_version and not re.fullmatch(r"[A-Za-z0-9._-]{1,40}", model_version):
            raise ValueError("AI 诊断模型版本不合法")
        result: dict[str, Any] = {
            "stage": stage,
            "model_version": model_version,
            "generated_code": str(value.get("generated_code") or "")[:30],
        }
        for field_name in ("participating_tables", "participating_fields", "validation_issue_count"):
            raw = value.get(field_name, 0)
            if isinstance(raw, bool):
                raise ValueError(f"AI 诊断字段 {field_name} 必须是非负整数")
            try:
                number = int(raw)
            except (TypeError, ValueError) as exc:
                raise ValueError(f"AI 诊断字段 {field_name} 必须是非负整数") from exc
            if number < 0 or number > 1_000_000:
                raise ValueError(f"AI 诊断字段 {field_name} 超出允许范围")
            result[field_name] = number
        if result["generated_code"] and not re.fullmatch(r"\d{1,6}/\d{1,6}", result["generated_code"]):
            raise ValueError("AI 诊断生成代码统计格式不合法")
        return result

    def _result_context(self) -> dict[str, Any]:
        with self.database().connect_data() as conn:
            try:
                latest = conn.execute("SELECT result_table FROM calculation_runs WHERE status = 'completed' ORDER BY completed_at DESC LIMIT 1").fetchone()
                table_name = latest[0] if latest else ""
                if not table_name or not table_name.replace("_", "").isalnum():
                    return {"available": False}
                columns = [row[1] for row in conn.execute(f'PRAGMA table_info("{table_name}")')]
                if not columns:
                    return {"available": False}
                count = conn.execute(f'SELECT COUNT(*) FROM "{table_name}"').fetchone()[0]
                # AI 数据答疑只能获知结果表名称、字段和记录数量，不能读取或上传任何真实结果行。
                return {"available": True, "result_table": table_name, "record_count": count, "columns": columns, "sample_rows": []}
            except Exception:
                return {"available": False}

    def _save_payroll_foundation_schema(self, body: dict[str, Any]) -> dict[str, Any]:
        """只保存薪资基础项目的结构与映射摘要，不接收或写入真实业务行。"""
        import re

        project_id = str(body.get("project_id", "")).strip()
        if not re.fullmatch(r"[a-z][a-z0-9_]{1,63}", project_id):
            raise ValueError("薪资基础项目标识不合法")
        fields = body.get("fields") or []
        sources = body.get("sources") or []
        mapping = body.get("mapping") or {}
        if not fields or not sources:
            raise ValueError("必须提供字段配置和至少一个模板来源")
        source_ids = {str(source.get("id") or "") for source in sources}
        if "" in source_ids or len(source_ids) != len(sources):
            raise ValueError("模板来源标识为空或重复")
        field_keys = {str(field.get("key") or "") for field in fields}
        missing = [str(field.get("label") or field.get("key")) for field in fields if field.get("required") and not mapping.get(field.get("key"))]
        if missing:
            raise ValueError("仍缺少必填字段映射：" + "、".join(missing))
        for field_key, reference in mapping.items():
            if field_key not in field_keys or "::" not in str(reference):
                raise ValueError(f"字段映射格式无效：{field_key}")
            source_id, column_name = str(reference).split("::", 1)
            if source_id not in source_ids or not column_name:
                raise ValueError(f"字段映射来源不存在：{field_key}")
        source_meta = [{
            "id": str(source.get("id")),
            "file_name": Path(str(source.get("file_name") or "template.xlsx")).name,
            "sheet_name": str(source.get("sheet_name") or ""),
            "header_row": max(1, int(source.get("header_row") or 1)),
            "columns": [str(column) for column in (source.get("columns") or [])],
        } for source in sources]
        now = datetime.now(timezone.utc).isoformat()
        database = self.database()
        with database.connect_config() as conn:
            conn.execute(
                "INSERT OR REPLACE INTO payroll_input_configs(project_id, display_name, mapping_json, sources_json, updated_at) VALUES (?, ?, ?, ?, ?)",
                (project_id, body.get("display_name") or project_id, json.dumps({"refs": mapping, "labels": body.get("mapping_display") or {}}, ensure_ascii=False), json.dumps(source_meta, ensure_ascii=False), now),
            )
        database.write_audit("payroll_foundation_schema_saved", "payroll_input", project_id, {"source_count": len(source_meta), "field_count": len(field_keys)})
        return {"project_id": project_id, "source_count": len(source_meta), "field_count": len(field_keys), "data_imported": False, "status": "confirmed"}

    def _send(self, status: HTTPStatus, body: dict[str, Any]) -> None:
        encoded = json.dumps(body, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(encoded)))
        self.send_header("Access-Control-Allow-Origin", "http://127.0.0.1:5173")
        self.end_headers()
        self.wfile.write(encoded)

    def database(self) -> OrganizationDatabase:
        organization_id = self.headers.get("X-Organization-ID", "")
        if not organization_id:
            items = self.registry.list()
            if not items:
                raise ValueError("尚未创建组织")
            organization_id = items[0]["organization_id"]
        item = next((row for row in self.registry.list() if row["organization_id"] == organization_id), None)
        if item is None:
            raise ValueError("当前组织不存在")
        return OrganizationDatabase(Path(item["storage_path"]))

    def _send_file(self, path: Path, content_type: str = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet") -> None:
        payload = path.read_bytes()
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", content_type)
        # BaseHTTPRequestHandler 的响应头使用 latin-1；中文文件名必须同时提供 ASCII 兼容名和 RFC 5987 UTF-8 文件名。
        ascii_name = "payroll-package.zip" if path.suffix.lower() == ".zip" else "payroll-result.xlsx"
        encoded_name = quote(path.name)
        self.send_header("Content-Disposition", f"attachment; filename=\"{ascii_name}\"; filename*=UTF-8''{encoded_name}")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Access-Control-Allow-Origin", "http://127.0.0.1:5173")
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, _format: str, *_args: object) -> None:
        return


def serve(workspace: Path, host: str = "127.0.0.1", port: int = 8787) -> None:
    # workspace 是源码目录；运行期数据库、结果和 AI 配置统一放到源码之外。
    data_directory = prepare_data_directory(Path(workspace))
    LocalAPIHandler.workspace = data_directory
    LocalAPIHandler.registry = OrganizationRegistry(data_directory)
    # 无论是首次安装还是从旧版本升级，都保证默认组织及其本地存储结构可用。
    default_directory = LocalAPIHandler.registry.ensure_default()
    OrganizationDatabase(default_directory)
    LocalAPIHandler.store = AISettingsStore(data_directory / "system_config.db")
    LocalAPIHandler.runtime_settings = RuntimeSettingsStore(data_directory / "runtime_settings.json")
    BoundedThreadingHTTPServer((host, port), LocalAPIHandler).serve_forever()
