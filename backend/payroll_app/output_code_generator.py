"""输出字段定义与受控 Python 代码生成。

AI 可以把自然语言转换为结构化表达式，但此模块只接受经过校验的表达式，
不会执行或拼接任意 AI 代码。
"""

from __future__ import annotations

import ast
import keyword
import re
from dataclasses import dataclass
from typing import Iterable


_IDENTIFIER = re.compile(r"^[a-z][a-z0-9_]{0,62}$")
_ALLOWED_NODES = (ast.Expression, ast.BinOp, ast.UnaryOp, ast.Add, ast.Sub, ast.Mult, ast.Div, ast.Mod, ast.Pow, ast.USub, ast.UAdd, ast.Name, ast.Load, ast.Constant, ast.Call)
_ALLOWED_FUNCTIONS = {"round", "min", "max", "abs"}


@dataclass(frozen=True)
class OutputFieldDefinition:
    name: str
    expression: str
    description: str = ""


class OutputCodeGenerator:
    def validate(self, fields: Iterable[OutputFieldDefinition], available_fields: Iterable[str]) -> list[OutputFieldDefinition]:
        available = set(available_fields)
        normalized = []
        for field in fields:
            if not _IDENTIFIER.fullmatch(field.name) or keyword.iskeyword(field.name):
                raise ValueError(f"输出字段名不合法: {field.name}")
            self._validate_expression(field.expression, available)
            normalized.append(field)
        if len({field.name for field in normalized}) != len(normalized):
            raise ValueError("输出字段名不能重复")
        return normalized

    def generate(self, fields: Iterable[OutputFieldDefinition], available_fields: Iterable[str]) -> str:
        available = list(available_fields)
        validated = self.validate(fields, available)
        lines = ["from __future__ import annotations", "", "def calculate_output(row: dict) -> dict:", "    result = dict(row)"]
        lines.extend(f"    {name} = row.get({name!r})" for name in available)
        for field in validated:
            lines.append(f"    result[{field.name!r}] = {field.expression}")
        lines.append("    return result")
        return "\n".join(lines) + "\n"

    @staticmethod
    def _validate_expression(expression: str, available: set[str]) -> None:
        try:
            tree = ast.parse(expression, mode="eval")
        except SyntaxError as exc:
            raise ValueError(f"输出表达式语法不合法: {expression}") from exc
        for node in ast.walk(tree):
            if not isinstance(node, _ALLOWED_NODES):
                raise ValueError(f"输出表达式包含不允许的运算: {type(node).__name__}")
            if isinstance(node, ast.Name) and node.id not in available and node.id not in _ALLOWED_FUNCTIONS:
                raise ValueError(f"输出表达式引用了未确认字段: {node.id}")
            if isinstance(node, ast.Call) and (not isinstance(node.func, ast.Name) or node.func.id not in _ALLOWED_FUNCTIONS):
                raise ValueError("只允许使用 round、min、max、abs 函数")
