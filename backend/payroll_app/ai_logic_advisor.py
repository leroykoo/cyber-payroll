"""计算逻辑的 AI 代码建议。

本模块只生成供用户审核的 Python 文本，不保存、不导入、更不会执行 AI 返回的代码。
传给 AI 的内容仅为规则描述和已确认字段名，不包含业务明细数据。
"""

from __future__ import annotations

import json
from typing import Any

from .ai_settings import CompatibleAIClient
from .safe_python import validate_rule_code


ALLOWED_RULE_CAPABILITIES = (
    "允许的基础函数仅包括：abs、all、any、bool、dict、enumerate、float、int、isinstance、len、list、"
    "max、min、range、round、set、sorted、str、sum、tuple、zip，以及 Decimal。"
)
SAFE_PAYROLL_HELPERS = (
    "空值和格式转换优先使用 safe_number、safe_decimal、safe_int；金额舍入使用 round_money；"
    "日期处理使用 parse_date、days_in_month；区间限制使用 clamp。不得自行 import，也不得自行用 try/except 处理转换失败。"
)


class CalculationLogicAdvisor:
    """将自然语言规则转换为待审核的 Python 代码建议。"""

    def __init__(self, client: CompatibleAIClient) -> None:
        self.client = client

    def generate(self, rule: dict[str, Any]) -> dict[str, str]:
        name = self._text(rule, "name", "逻辑名称")
        description = self._text(rule, "description", "自然语言计算逻辑")
        scope = str(rule.get("scope") or "global")
        table = str(rule.get("table") or "")
        fields = [str(item) for item in rule.get("available_fields", []) if str(item).strip()]
        prompt = {
            "任务": "将薪酬核算规则转换为待人工审核的 Python 函数代码。",
            "限制": [
                "不得读取文件、访问网络、使用 eval、exec、import 或动态属性访问。",
                "只可使用函数参数 rows、context 和 Python 标准算术、比较、条件、循环。",
                ALLOWED_RULE_CAPABILITIES,
                SAFE_PAYROLL_HELPERS,
                "不得执行代码；仅返回 JSON。",
                "若规则信息不足，返回 review_notes 说明缺少什么，不要编造字段。",
                "available_fields 中以 output. 开头的字段表示已定义的输出模板字段；引用 output.xxx 时，代码必须从 context.get('xxx', 0) 读取，不得从 rows 读取。",
                "available_fields 中以 temp. 开头的字段表示已计算的临时字段；引用 temp.xxx 时必须从 context.get('xxx', 0) 读取。若 scope 为 temporary，函数必须返回 {'目标临时字段名': 值}。",
            ],
            "规则": {"name": name, "scope": scope, "table": table, "description": description, "available_fields": fields},
            "返回格式": {"summary": "简短中文说明", "python_code": "完整函数代码", "review_notes": "审核注意事项"},
        }
        content = self.client.complete(
            [
                {"role": "system", "content": "你是薪酬核算的 Python 代码建议助手。只返回合法 JSON，不使用 Markdown 代码块。"},
                {"role": "user", "content": json.dumps(prompt, ensure_ascii=False)},
            ]
        )
        result = self._parse(content)
        code = str(result.get("python_code") or "").strip()
        if not code:
            raise ValueError("AI 未返回 Python 代码")
        validate_rule_code(code, name)
        return {
            "logic_name": name,
            "summary": str(result.get("summary") or "已生成待审核的代码建议"),
            "python_code": code,
            "review_notes": str(result.get("review_notes") or "请在保存到计算模型前审核代码和字段引用。"),
        }

    def generate_batch(self, payload: dict[str, Any]) -> dict[str, list[dict[str, str]]]:
        """基于完整规则集统一生成代码，供前端在全部描述完成后一次审核。"""
        fields = [str(item) for item in payload.get("available_fields", []) if str(item).strip()]
        output_fields = [item for item in payload.get("output_fields", []) if isinstance(item, dict) and str(item.get("name") or "").strip()]
        raw_rules = payload.get("rules") or []
        rules = []
        for item in raw_rules:
            key = str(item.get("key") or "").strip()
            name = str(item.get("name") or "").strip()
            description = str(item.get("description") or "").strip()
            if key and name and description:
                rules.append({"key": key, "name": name, "scope": str(item.get("scope") or "global"), "table": str(item.get("table") or ""), "description": description, "output_dependencies": [str(ref) for ref in item.get("output_dependencies", []) if str(ref).strip()]})
        if not rules:
            raise ValueError("请先填写至少一条自然语言计算逻辑")
        batch_index = int(payload.get("batch_index") or 1)
        batch_total = int(payload.get("batch_total") or 1)
        previous_results = [item for item in payload.get("previous_results", []) if isinstance(item, dict)][:12]
        prompt = {
            "任务": f"这是第 {batch_index}/{batch_total} 批薪酬规则。基于本批规则和前序批次摘要，生成待人工审核的 Python 计算函数；必须综合规则之间的字段依赖、优先级和执行范围，不要把每条规则视为孤立任务。",
            "限制": [
                "不得读取文件、访问网络、使用 eval、exec、import 或动态属性访问。",
                "每条规则返回一个完整函数代码，只可使用 rows、context 和 Python 标准算术、比较、条件、循环。",
                ALLOWED_RULE_CAPABILITIES,
                SAFE_PAYROLL_HELPERS,
                "不得执行代码；仅返回 JSON。",
                "不得编造不存在的字段；字段引用仅可使用 available_fields。",
                "available_fields 中以 output. 开头的字段表示输出模板字段，必须通过 context.get('字段名', 0) 读取；不得把 output.xxx 当作 rows 中的输入表字段。",
                "available_fields 中以 temp. 开头的字段表示已计算的临时字段，必须通过 context.get('字段名', 0) 读取；temporary 范围必须返回目标临时字段名对应的字典。",
            ],
            "available_fields": fields,
            "output_fields": output_fields,
            "前序批次结果摘要": previous_results,
            "rules": rules,
            "返回格式": {"items": [{"key": "规则 key", "summary": "简短中文说明", "python_code": "完整函数代码", "review_notes": "审核注意事项"}]},
        }
        content = self.client.complete(
            [
                {"role": "system", "content": "你是薪酬核算的 Python 代码建议助手。统一分析全部规则后，只返回合法 JSON，不使用 Markdown 代码块。"},
                {"role": "user", "content": json.dumps(prompt, ensure_ascii=False)},
            ]
        )
        result = self._parse(content)
        returned = result.get("items")
        if not isinstance(returned, list):
            raise ValueError("AI 未返回统一生成的规则列表")
        expected = {item["key"] for item in rules}
        rule_names = {item["key"]: item["name"] for item in rules}
        items = []
        for item in returned:
            key = str(item.get("key") or "").strip()
            code = str(item.get("python_code") or "").strip()
            if key in expected and code:
                validate_rule_code(code, rule_names.get(key, key))
                items.append({"key": key, "summary": str(item.get("summary") or "已生成待审核的代码建议"), "python_code": code, "review_notes": str(item.get("review_notes") or "请在保存到计算模型前审核代码和字段引用。")})
        if not items:
            raise ValueError("AI 未返回可用的统一生成代码")
        return {"items": items}

    @staticmethod
    def _text(rule: dict[str, Any], key: str, label: str) -> str:
        value = str(rule.get(key) or "").strip()
        if not value:
            raise ValueError(f"{label}不能为空")
        return value

    @staticmethod
    def _parse(content: str) -> dict[str, Any]:
        text = content.strip()
        if text.startswith("```"):
            text = text.split("\n", 1)[-1].rsplit("```", 1)[0].strip()
        try:
            result = json.loads(text)
        except json.JSONDecodeError as exc:
            raise ValueError("AI 返回的代码建议不是合法 JSON") from exc
        if not isinstance(result, dict):
            raise ValueError("AI 返回的代码建议格式不正确")
        return result
