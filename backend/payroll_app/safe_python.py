"""薪酬规则共用的受控 Python 能力与静态校验。"""

from __future__ import annotations

import ast
import calendar
from datetime import date, datetime, timedelta
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from typing import Any


def safe_number(value: Any, default: float = 0.0) -> float:
    """将常见薪酬数值安全转换为 float，空值或非法值返回默认值。"""
    if value in (None, ""):
        return float(default)
    try:
        return float(str(value).replace(",", "").strip())
    except (TypeError, ValueError):
        return float(default)


def safe_decimal(value: Any, default: Any = "0") -> Decimal:
    """将常见薪酬数值安全转换为 Decimal。"""
    if value in (None, ""):
        return Decimal(str(default))
    try:
        parsed = Decimal(str(value).replace(",", "").strip())
        return parsed if parsed.is_finite() else Decimal(str(default))
    except (InvalidOperation, TypeError, ValueError):
        return Decimal(str(default))


def safe_int(value: Any, default: int = 0) -> int:
    """将整数型配置安全转换为 int。"""
    try:
        return int(safe_number(value, default))
    except (TypeError, ValueError):
        return int(default)


def round_money(value: Any, places: int = 2) -> Decimal:
    """按财务常用的 ROUND_HALF_UP 规则保留指定位数。"""
    digits = max(0, min(6, safe_int(places, 2)))
    quantizer = Decimal("1").scaleb(-digits)
    return safe_decimal(value).quantize(quantizer, rounding=ROUND_HALF_UP)


def parse_date(value: Any) -> date | None:
    """解析常见的年月日格式，不允许规则自行导入日期模块。"""
    text = str(value or "").strip()
    if not text or text in {"-", "--"}:
        return None
    normalized = text.replace("年", "-").replace("月", "-").replace("日", "").replace("/", "-").replace(".", "-")
    for pattern in ("%Y-%m-%d", "%Y-%m", "%Y%m%d", "%Y%m"):
        try:
            return datetime.strptime(normalized, pattern).date()
        except ValueError:
            continue
    return None


def days_in_month(year: Any, month: Any) -> int:
    """返回指定年月的自然日数，参数非法时返回 0。"""
    parsed_year = safe_int(year)
    parsed_month = safe_int(month)
    if parsed_year < 1 or not 1 <= parsed_month <= 12:
        return 0
    return calendar.monthrange(parsed_year, parsed_month)[1]


def clamp(value: Any, minimum: Any, maximum: Any) -> Any:
    return max(minimum, min(maximum, value))


SAFE_BUILTINS: dict[str, Any] = {
    "abs": abs,
    "all": all,
    "any": any,
    "bool": bool,
    "dict": dict,
    "enumerate": enumerate,
    "float": float,
    "int": int,
    "isinstance": isinstance,
    "len": len,
    "list": list,
    "max": max,
    "min": min,
    "range": range,
    "round": round,
    "set": set,
    "sorted": sorted,
    "str": str,
    "sum": sum,
    "tuple": tuple,
    "zip": zip,
}

SAFE_GLOBALS: dict[str, Any] = {
    "Decimal": Decimal,
    "date": date,
    "datetime": datetime,
    "timedelta": timedelta,
    "safe_number": safe_number,
    "safe_decimal": safe_decimal,
    "safe_int": safe_int,
    "round_money": round_money,
    "parse_date": parse_date,
    "days_in_month": days_in_month,
    "clamp": clamp,
}

SAFE_CALLABLE_NAMES = set(SAFE_BUILTINS) | set(SAFE_GLOBALS)
SAFE_METHODS = {
    "append", "clear", "copy", "count", "date", "endswith", "extend", "fromisoformat",
    "get", "index", "insert", "isdecimal", "isdigit", "isoformat", "items", "join", "keys",
    "lower", "lstrip", "pop", "remove", "replace", "reverse", "rstrip", "setdefault", "sort",
    "split", "startswith", "strip", "strftime", "strptime", "total_seconds", "upper", "values", "zfill",
}
SAFE_READ_ATTRIBUTES = SAFE_METHODS | {"day", "days", "month", "seconds", "year"}
DANGEROUS_CALLS = {
    "breakpoint", "compile", "delattr", "dir", "eval", "exec", "getattr", "globals", "hasattr",
    "help", "input", "locals", "memoryview", "open", "setattr", "vars", "__import__",
}
BLOCKED_NODES = (
    ast.AsyncFor, ast.AsyncFunctionDef, ast.AsyncWith, ast.Await, ast.ClassDef, ast.Delete, ast.Global,
    ast.Import, ast.ImportFrom, ast.Lambda, ast.Nonlocal, ast.Raise, ast.Try, ast.With, ast.Yield, ast.YieldFrom,
)
BLOCKED_NODE_NAMES = {
    ast.AsyncFor: "async for", ast.AsyncFunctionDef: "异步函数", ast.AsyncWith: "async with", ast.Await: "await",
    ast.ClassDef: "class", ast.Delete: "del", ast.Global: "global", ast.Import: "import 导入",
    ast.ImportFrom: "from ... import 导入", ast.Lambda: "lambda", ast.Nonlocal: "nonlocal", ast.Raise: "raise",
    ast.Try: "try/except", ast.With: "with", ast.Yield: "yield", ast.YieldFrom: "yield from",
}


def validate_rule_code(code: str, rule_label: str = "未命名规则") -> tuple[ast.Module, str]:
    """按生成器和执行器共用的同一策略校验规则，并返回入口函数名。"""
    try:
        tree = ast.parse(str(code or ""), mode="exec")
    except SyntaxError as exc:
        raise ValueError(f"规则“{rule_label}”的 Python 代码第 {exc.lineno or '?'} 行存在语法错误：{exc.msg}") from exc

    lines = str(code or "").splitlines()
    blocked_node = next((node for node in ast.walk(tree) if isinstance(node, BLOCKED_NODES)), None)
    if blocked_node is not None:
        line_number = getattr(blocked_node, "lineno", "?")
        statement_name = BLOCKED_NODE_NAMES.get(type(blocked_node), type(blocked_node).__name__)
        source_line = lines[line_number - 1].strip() if isinstance(line_number, int) and 0 < line_number <= len(lines) else statement_name
        raise ValueError(f"规则“{rule_label}”第 {line_number} 行包含不允许执行的 Python 语句：{statement_name}；代码：{source_line}")

    function_names = {node.name for node in ast.walk(tree) if isinstance(node, ast.FunctionDef)}
    entry_functions = [node.name for node in tree.body if isinstance(node, ast.FunctionDef)]
    if not entry_functions:
        raise ValueError(f"规则“{rule_label}”没有可执行的计算函数，请重新生成 Python 代码")

    defined_names = set(SAFE_CALLABLE_NAMES) | function_names
    for node in ast.walk(tree):
        if isinstance(node, ast.arg):
            defined_names.add(node.arg)
        elif isinstance(node, ast.Name) and isinstance(node.ctx, (ast.Store, ast.Param)):
            defined_names.add(node.id)

    for node in ast.walk(tree):
        line_number = getattr(node, "lineno", "?")
        if isinstance(node, ast.Name) and node.id.startswith("__"):
            raise ValueError(f"规则“{rule_label}”第 {line_number} 行使用了不允许的内部名称：{node.id}")
        if isinstance(node, ast.Attribute):
            if node.attr.startswith("_") or node.attr not in SAFE_READ_ATTRIBUTES:
                raise ValueError(f"规则“{rule_label}”第 {line_number} 行访问了未开放的属性或方法：.{node.attr}")
        if isinstance(node, ast.Call):
            if isinstance(node.func, ast.Name):
                call_name = node.func.id
                if call_name in DANGEROUS_CALLS:
                    raise ValueError(f"规则“{rule_label}”第 {line_number} 行调用了不允许的函数：{call_name}()")
                if call_name not in SAFE_CALLABLE_NAMES and call_name not in function_names:
                    raise ValueError(f"规则“{rule_label}”第 {line_number} 行调用了未开放的函数：{call_name}()")
            elif isinstance(node.func, ast.Attribute) and node.func.attr not in SAFE_METHODS:
                raise ValueError(f"规则“{rule_label}”第 {line_number} 行调用了未开放的方法：.{node.func.attr}()")
        if isinstance(node, ast.Name) and isinstance(node.ctx, ast.Load) and node.id not in defined_names:
            raise ValueError(f"规则“{rule_label}”第 {line_number} 行引用了未定义或未开放的名称：{node.id}")

    return tree, entry_functions[0]
