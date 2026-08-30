"""Excel 结构建议的 AI 适配层。

本模块不依赖具体模型供应商，也不自动发送文件内容。调用方提供一个
``complete(prompt)`` 函数即可接入本地模型或企业内部 AI；返回结果必须经过
白名单和结构校验，最终仍由用户确认后才保存 Schema。
"""

from __future__ import annotations

import json
import re
from collections.abc import Callable
from typing import Any

from .template_inspector import TemplateInspector


class SchemaAdvisor:
    def __init__(self, complete: Callable[[str], str] | None = None) -> None:
        self.complete = complete

    def build_prompt(self, inspection: dict[str, Any]) -> str:
        payload = {
            "sheet_name": inspection.get("sheet_name"),
            "header_row": inspection.get("header_row"),
            "columns": inspection.get("columns", []),
        }
        return (
            "你是企业数据建模顾问。请根据下面的 Excel 结构摘要给出字段映射建议。"
            "只能返回 JSON，不得虚构摘要中不存在的 Excel 列。"
            "每个 columns 项返回 excel_name、suggested_db_name、sqlite_type、"
            "transform_rule、selected、reason；sqlite_type 只能是 TEXT、INTEGER、"
            "REAL、NUMERIC。表头可能包含业务中文名称，请使用小写 snake_case 作为数据库字段名。\n"
            + json.dumps(payload, ensure_ascii=False)
        )

    def advise(self, inspection: dict[str, Any]) -> dict[str, Any]:
        """返回 AI 建议；没有配置 AI 时返回规则建议并标记来源。"""
        if self.complete is None:
            return self._rule_advice(inspection)
        raw = self.complete(self.build_prompt(inspection))
        try:
            result = json.loads(raw)
        except json.JSONDecodeError as exc:
            raise ValueError("AI 返回的结构建议不是合法 JSON") from exc
        return self._validate(result, inspection)

    def _rule_advice(self, inspection: dict[str, Any]) -> dict[str, Any]:
        columns = []
        for column in inspection.get("columns", []):
            name = self._identifier(column["excel_name"])
            columns.append({"excel_name": column["excel_name"], "suggested_db_name": name, "sqlite_type": column["suggested_sqlite_type"], "transform_rule": column["suggested_transform_rule"], "selected": True, "reason": "基于单元格类型统计生成的规则建议"})
        return {"source": "rule", "columns": columns}

    @staticmethod
    def _identifier(value: str) -> str:
        value = re.sub(r"[^a-zA-Z0-9]+", "_", value).strip("_").lower() or "field"
        if value[0].isdigit():
            value = "field_" + value
        return value[:63]

    @staticmethod
    def _validate(result: dict[str, Any], inspection: dict[str, Any]) -> dict[str, Any]:
        expected = {column["excel_name"] for column in inspection.get("columns", [])}
        seen: set[str] = set()
        for item in result.get("columns", []):
            source = item.get("excel_name")
            if source not in expected or source in seen:
                raise ValueError(f"AI 返回了不存在或重复的 Excel 列: {source}")
            seen.add(source)
            if item.get("sqlite_type") not in {"TEXT", "INTEGER", "REAL", "NUMERIC"}:
                raise ValueError(f"AI 返回了不支持的 SQLite 类型: {item.get('sqlite_type')}")
            if not re.fullmatch(r"[a-z][a-z0-9_]{0,62}", item.get("suggested_db_name", "")):
                raise ValueError("AI 建议的数据库字段名不符合小写 snake_case 规则")
        return {"source": "ai", "columns": result["columns"], "unmapped_columns": sorted(expected - seen)}

