"""面向总览页的数据答疑建议器。"""

from __future__ import annotations

import json
from typing import Any

from .ai_settings import CompatibleAIClient


class DataQuestionAdvisor:
    def __init__(self, client: CompatibleAIClient) -> None:
        self.client = client

    def answer(self, *, question: str, schema: list[dict[str, Any]], result_context: dict[str, Any] | None = None) -> dict[str, Any]:
        if not question.strip():
            raise ValueError("数据问题不能为空")
        prompt = {
            "任务": "回答本地薪酬核算系统中的数据问题，只能依据已确认的数据表、字段和计算模型解释，不得编造业务数据。",
            "问题": question.strip(),
            "已确认结构": schema,
            "本地核算结果摘要": result_context or {"available": False},
            "返回格式": {"answer": "中文结论", "result": "与问题对应的计算结果或结果摘要", "references": ["表名.字段名"], "steps": ["按顺序列出计算步骤"]},
        }
        content = self.client.complete([
            {"role": "system", "content": "你是薪酬数据答疑助手，只返回合法 JSON，不使用 Markdown。"},
            {"role": "user", "content": json.dumps(prompt, ensure_ascii=False)},
        ])
        text = content.strip()
        if text.startswith("```"):
            text = text.split("\n", 1)[-1].rsplit("```", 1)[0].strip()
        try:
            result = json.loads(text)
        except json.JSONDecodeError as exc:
            raise ValueError("AI 返回的答疑结果不是合法 JSON") from exc
        if not isinstance(result, dict):
            raise ValueError("AI 返回的答疑结果格式不正确")
        return {"answer": str(result.get("answer") or "AI 未给出明确结论"), "result": str(result.get("result") or "请以本地核算结果表为准"), "references": [str(item) for item in result.get("references", [])], "steps": [str(item) for item in result.get("steps", [])]}
