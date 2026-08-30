"""本地核算执行器：从组织 SQLite 读取数据，计算并写入结果表。"""

from __future__ import annotations

import hashlib
import json
import sqlite3
import uuid
import re
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .excel_exporter import ExcelResultExporter
from .organization_db import OrganizationDatabase
from .rule_worker import RuleExecutionSandbox


class CalculationEngine:
    """执行受控的本地核算流程，不直接读取前端状态或原始 Excel。"""

    RESULT_TABLE = "local_calculation_result"
    OUTPUT_REFERENCE_PATTERN = re.compile(r"@output\.([a-z][a-z0-9_]*)")
    TEMP_REFERENCE_PATTERN = re.compile(r"@temp\.([a-z][a-z0-9_]*)")

    def __init__(self, database: OrganizationDatabase) -> None:
        self.database = database

    def run(self, *, model_version_id: str | None, period: str) -> dict[str, Any]:
        # 正式核算只读取配置库中已发布的固定模型，不接受前端临时传入的规则集合。
        model = self.database.load_published_calculation_model(model_version_id)
        model_version = model["model_version"]
        rules = model["rules"]
        input_pages = self._validate_imported_schema_versions()
        output_fields = self._load_confirmed_output_fields()
        if not output_fields:
            raise ValueError("尚未确认输出模板，请先在“输出”页确认模板并更新数据库")
        output_rules = rules.get("output_field_rules") or []
        output_rule_map = {str(item.get("field_name")): item for item in output_rules}
        missing_rules = [str(field.get("name")) for field in output_fields if str(field.get("name")) not in output_rule_map]
        if missing_rules:
            raise ValueError(f"请先在“核算”页配置输出字段来源或计算逻辑：{', '.join(missing_rules[:5])}")
        custom_rules = {str(item.get("name")): item for item in rules.get("custom", [])}
        for field in output_fields:
            name = str(field.get("name", ""))
            if name in custom_rules and (custom_rules[name].get("status") != "已解析" or not custom_rules[name].get("generatedCode")):
                raise ValueError(f"输出字段 {name} 尚未完成并发布计算逻辑")
        run_id = f"RUN-{datetime.now().strftime('%Y%m%d%H%M%S')}-{uuid.uuid4().hex[:6].upper()}"
        now = datetime.now(timezone.utc).isoformat()
        output_fields = self._normalize_output_fields(output_fields)
        result_table = f"local_calculation_result_{run_id.lower().replace('-', '_')}"
        self.database.save_output_schema(schema_name=result_table, ordered_fields=output_fields, excel_header_groups=[])
        self.database.prepare_output_table(result_table, output_fields)
        with self.database.connect_data() as conn:
            input_rows = self._load_input_rows(conn, period, input_pages)
            input_hash = hashlib.sha256(json.dumps(input_rows, ensure_ascii=False, default=str, sort_keys=True).encode()).hexdigest()
            conn.execute(
                "INSERT INTO calculation_runs(run_id, model_version, model_version_id, period, status, input_hash, result_table, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (run_id, model_version, model["model_version_id"], period, "running", input_hash, result_table, now),
            )
            columns = [field["name"] for field in output_fields]
            placeholders = ", ".join("?" for _ in columns)
            sql = f"INSERT INTO {self._quote(result_table)} (_sys_run_id, _sys_period, _sys_calculated_at, {', '.join(self._quote(name) for name in columns)}) VALUES (?, ?, ?, {placeholders})"
            with RuleExecutionSandbox() as rule_executor:
                for source in input_rows:
                    calculated = self._calculate_row(source, columns, {**rules, "_period": period}, output_rule_map, {field["name"]: field.get("display_name") or field["name"] for field in output_fields}, rule_executor)
                    conn.execute(sql, [run_id, period, now, *[self._db_value(calculated.get(name)) for name in columns]])
            completed = datetime.now(timezone.utc).isoformat()
            conn.execute("UPDATE calculation_runs SET status = ?, completed_at = ? WHERE run_id = ?", ("completed", completed, run_id))
        self.database.write_audit("calculation_completed", "calculation_run", run_id, {"result_table": result_table, "record_count": len(input_rows)})
        return {"run_id": run_id, "result_table": result_table, "record_count": len(input_rows), "status": "completed", "completed_at": completed}

    def _load_confirmed_output_fields(self) -> list[dict[str, Any]]:
        """输出模板是结果表的唯一来源，核算不接受前端临时字段定义。"""
        with self.database.connect_config() as conn:
            row = conn.execute(
                "SELECT fields_json FROM output_schemas WHERE schema_name = ?",
                (self.RESULT_TABLE,),
            ).fetchone()
        if not row:
            return []
        try:
            fields = json.loads(row[0])
        except (TypeError, json.JSONDecodeError) as exc:
            raise ValueError("已保存的输出模板无效，请重新确认输出模板") from exc
        if not isinstance(fields, list):
            raise ValueError("已保存的输出模板格式无效，请重新确认输出模板")
        return fields

    def export(self, *, schema_name: str = RESULT_TABLE, file_name: str | None = None) -> Path:
        requested_name = Path(file_name or f"{schema_name}_{datetime.now().strftime('%Y%m%d_%H%M%S')}.xlsx").name
        if not requested_name.lower().endswith(".xlsx"):
            requested_name += ".xlsx"
        if schema_name == self.RESULT_TABLE:
            with self.database.connect_data() as conn:
                latest = conn.execute("SELECT result_table FROM calculation_runs WHERE status = 'completed' ORDER BY completed_at DESC LIMIT 1").fetchone()
                if latest:
                    schema_name = latest[0]
        output = self.database.output_dir / requested_name
        with self.database.connect_data() as data_conn, self.database.connect_config() as config_conn:
            return ExcelResultExporter().export(data_conn, schema_connection=config_conn, schema_name=schema_name, output_path=output)

    def _validate_imported_schema_versions(self) -> list[str]:
        """计算前确认每张真实数据表仍对应当前已确认的轻量 Schema。"""
        with self.database.connect_config() as config_conn:
            pages = [row[0] for row in config_conn.execute("SELECT technical_name FROM data_pages ORDER BY technical_name")]
        if not pages:
            raise ValueError("尚未确认参与核算的数据源表结构")
        with self.database.connect_data() as data_conn:
            for page_name in pages:
                latest = data_conn.execute(
                    "SELECT schema_hash, status FROM import_batches WHERE page_name = ? ORDER BY created_at DESC LIMIT 1",
                    (page_name,),
                ).fetchone()
                if latest is None or latest[1] != "completed":
                    raise ValueError(f"数据源 {page_name} 尚未导入可计算的真实业务数据")
                expected_hash = self.database.schema_fingerprint(page_name)
                if not latest[0] or latest[0] != expected_hash:
                    raise ValueError(f"数据源 {page_name} 的真实数据与当前确认表结构不一致，请重新校验并导入")
        return pages

    def _load_input_rows(self, conn: sqlite3.Connection, period: str, pages: list[str]) -> list[dict[str, Any]]:
        merged: dict[tuple[Any, Any], dict[str, Any]] = {}
        for page in pages:
            table = f"data_{page}"
            try:
                rows = conn.execute(f"SELECT * FROM {self._quote(table)}").fetchall()
            except sqlite3.OperationalError:
                continue
            for row in rows:
                item = dict(row)
                if period and item.get("_sys_period") not in (None, "", period):
                    continue
                # 所有输入表都必须按员工 UID 合并；月度汇总表历史上使用 employee_id，
                # 因此将 employee_id 作为同一员工键的兼容别名，绝不能用各表自增的
                # _sys_id 跨表关联，否则不同表的第 1 行会被误认为同一个人。
                employee_key = CalculationEngine._employee_key(item)
                # 没有 UID/工号的公司汇总或其他非员工明细行无法可靠归属到个人，
                # 不应生成一条“无 UID”核算结果。
                if not employee_key:
                    continue
                key = (employee_key, item.get("_sys_period") or period)
                target = merged.setdefault(key, {})
                for key_name, value in item.items():
                    if key_name.startswith("_sys_"):
                        continue
                    target[f"{page}.{key_name}"] = value
                    if key_name in target and self._is_amount_field(key_name):
                        target[key_name] = self._decimal(target[key_name]) + self._decimal(value)
                    elif key_name not in target or target[key_name] in (None, ""):
                        target[key_name] = value
        return list(merged.values())

    @staticmethod
    def _employee_key(item: dict[str, Any]) -> str:
        """返回跨输入表统一使用的员工键；UID 和 employee_id 是同一概念的兼容命名。"""
        for field_name in ("uid", "employee_id", "employee_no", "employee_number"):
            value = item.get(field_name)
            if value not in (None, ""):
                normalized = str(value).strip()
                if normalized:
                    return normalized
        return ""

    @staticmethod
    def _calculate_row(source: dict[str, Any], columns: list[str], rules: dict[str, Any], output_rule_map: dict[str, dict[str, Any]], output_display_names: dict[str, str] | None = None, rule_executor: RuleExecutionSandbox | None = None) -> dict[str, Any]:
        # 法定节假日历作为受控上下文传给规则代码，不写入结果表业务字段。
        source["__statutory_holidays__"] = rules.get("statutory_holidays", [])
        source["__sick_leave_policy__"] = rules.get("sick_leave_policy", [])
        source["__sick_leave_high_income_cap__"] = rules.get("sick_leave_high_income_cap", {})
        source["__sick_leave_hire_date_field__"] = rules.get("sick_leave_hire_date_field", "")
        source["__sick_leave_base_field__"] = rules.get("sick_leave_base_field", "")
        source["__minimum_wage_rule__"] = rules.get("minimum_wage_rule", {})
        source["__net_income_field__"] = rules.get("net_income_field", "")
        source["__absence_days_field__"] = rules.get("absence_days_field", "")
        source["__standard_work_days_field__"] = rules.get("standard_work_days_field", "")
        source["__attendance_schedule__"] = rules.get("attendance_schedule", [])
        source["__shift_field__"] = rules.get("shift_field", "")
        result = dict(source)
        # 临时字段只存在于本次员工核算上下文，不写入最终输出表；先按 @temp 依赖顺序执行。
        for field in CalculationEngine._ordered_temporary_fields(rules.get("temporary", [])):
            if field.get("status") != "已解析" or not field.get("generated_code"):
                continue
            patch = CalculationEngine._execute_approved_rule(rule_executor, field["generated_code"], source, result, f"临时字段：{field.get('display_name') or field.get('name')}")
            name = str(field.get("name") or "")
            if not isinstance(patch, dict) or name not in patch:
                raise ValueError(f"临时字段 {name} 的代码必须返回包含该字段名的字典，例如 {{'{name}': 值}}")
            result[name] = patch[name]
        for field_name, rule in output_rule_map.items():
            if rule.get("mode") == "source":
                source_ref = str(rule.get("source_ref") or "")
                if not source_ref.startswith("output."):
                    result[field_name] = source.get(source_ref)
            elif rule.get("mode") == "fixed":
                result[field_name] = rule.get("fixed_value")
        ordered_output_rules = CalculationEngine._ordered_output_rules(output_rule_map, columns)
        ordered_formula_rules = [(field_name, rule) for field_name, rule in ordered_output_rules if rule.get("mode") == "formula"]
        scoped_rules = (
            [(0, item) for item in rules.get("global", [])]
            + [(0, item) for item in rules.get("custom", [])]
            + [(1, item) for item in rules.get("table", [])]
            + [(2, item) for item in rules.get("statutory", [])]
        )
        executable_rules = [item for _, item in sorted(scoped_rules[:len(rules.get("global", [])) + len(rules.get("custom", []))], key=lambda entry: (entry[0], int(entry[1].get("priority", 0))))]
        # 业务公式不在引擎中写死；只有用户确认并发布的规则代码才会改变结果。
        for rule in executable_rules:
            if rule.get("status") != "已解析" or not rule.get("generatedCode"):
                continue
            patch = CalculationEngine._execute_approved_rule(rule_executor, rule["generatedCode"], source, result, CalculationEngine._rule_label(rule, "全局/自定义计算规则"))
            if isinstance(patch, dict):
                result.update(patch)
        for field_name, rule in ordered_output_rules:
            if rule.get("mode") == "source":
                result[field_name] = CalculationEngine._value_for_reference(rule.get("source_ref"), result, source)
            elif rule.get("mode") == "fixed":
                result[field_name] = rule.get("fixed_value")
            elif rule.get("mode") == "formula" and rule.get("status") == "已解析" and rule.get("generated_code"):
                display_name = (output_display_names or {}).get(field_name, field_name)
                patch = CalculationEngine._execute_approved_rule(rule_executor, rule["generated_code"], source, result, f"输出字段：{display_name}（{field_name}）")
                if isinstance(patch, dict):
                    result.update(patch)
        executable_rules = [item for _, item in sorted(scoped_rules[len(rules.get("global", [])) + len(rules.get("custom", [])):], key=lambda entry: (entry[0], int(entry[1].get("priority", 0))))]
        for rule in executable_rules:
            if rule.get("status") != "已解析" or not rule.get("generatedCode"):
                continue
            patch = CalculationEngine._execute_approved_rule(rule_executor, rule["generatedCode"], source, result, CalculationEngine._rule_label(rule, "法定/单表计算规则"))
            if isinstance(patch, dict):
                result.update(patch)
        # 最低工资保底采用固定顺序：先判断实际收入是否触发保底，再还原满勤状态
        # 检查是否需要补足，最后保留（恢复前已存在的）实际考勤扣减。这样不会把
        # 缺勤扣减重复执行，也不会让“保底”规则被普通公式的执行顺序意外绕过。
        CalculationEngine._apply_minimum_wage_floor(source, result, columns, rules)
        return {name: result.get(name) for name in columns}

    @staticmethod
    def _ordered_output_rules(output_rule_map: dict[str, dict[str, Any]], columns: list[str]) -> list[tuple[str, dict[str, Any]]]:
        """按输出字段之间的依赖顺序执行来源、固定值和公式，并拒绝循环或未知引用。"""
        field_names = set(columns)
        dependencies: dict[str, list[str]] = {}
        for field_name, rule in output_rule_map.items():
            refs: list[str] = []
            if rule.get("mode") == "source" and str(rule.get("source_ref") or "").startswith("output."):
                refs.append(str(rule["source_ref"])[len("output."):])
            elif rule.get("mode") == "formula":
                refs.extend(CalculationEngine.OUTPUT_REFERENCE_PATTERN.findall(str(rule.get("description") or "")))
            unknown = [ref for ref in refs if ref not in field_names]
            if unknown:
                raise ValueError(f"输出字段 {field_name} 引用了不存在的输出字段: {', '.join(sorted(set(unknown)))}")
            dependencies[field_name] = [ref for ref in refs if ref in output_rule_map]

        ordered_names: list[str] = []
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
            ordered_names.append(field_name)

        for field_name in columns:
            if field_name in output_rule_map:
                visit(field_name)
        return [(field_name, output_rule_map[field_name]) for field_name in ordered_names]

    @staticmethod
    def _ordered_temporary_fields(fields: list[dict[str, Any]]) -> list[dict[str, Any]]:
        by_name = {str(item.get("name") or ""): item for item in fields if str(item.get("name") or "")}
        dependencies = {name: CalculationEngine.TEMP_REFERENCE_PATTERN.findall(str(item.get("description") or "")) for name, item in by_name.items()}
        ordered: list[str] = []
        visiting: list[str] = []
        visited: set[str] = set()
        def visit(name: str) -> None:
            if name in visiting:
                start = visiting.index(name)
                raise ValueError(f"临时字段计算逻辑存在循环引用: {' -> '.join([*visiting[start:], name])}")
            if name in visited:
                return
            unknown = [ref for ref in dependencies.get(name, []) if ref not in by_name]
            if unknown:
                raise ValueError(f"临时字段 {name} 引用了不存在的临时字段: {', '.join(sorted(set(unknown)))}")
            visiting.append(name)
            for dependency in dependencies.get(name, []):
                visit(dependency)
            visiting.pop()
            visited.add(name)
            ordered.append(name)
        for name in sorted(by_name, key=lambda item: (int(by_name[item].get("priority") or 100), item)):
            visit(name)
        return [by_name[name] for name in ordered]

    @staticmethod
    def _ordered_output_formula_rules(output_rule_map: dict[str, dict[str, Any]], columns: list[str]) -> list[tuple[str, dict[str, Any]]]:
        """按 @output.<字段名> 依赖顺序执行结果模板公式，并拒绝循环或未知引用。"""
        field_names = set(columns)
        formula_rules = {name: item for name, item in output_rule_map.items() if item.get("mode") == "formula"}
        dependencies: dict[str, list[str]] = {}
        for field_name, rule in formula_rules.items():
            refs = CalculationEngine.OUTPUT_REFERENCE_PATTERN.findall(str(rule.get("description") or ""))
            unknown = [ref for ref in refs if ref not in field_names]
            if unknown:
                raise ValueError(f"输出字段 {field_name} 引用了不存在的输出字段: {', '.join(sorted(set(unknown)))}")
            dependencies[field_name] = [ref for ref in refs if ref in formula_rules]

        ordered_names: list[str] = []
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
            ordered_names.append(field_name)

        for column in columns:
            if column in formula_rules:
                visit(column)
        return [(field_name, formula_rules[field_name]) for field_name in ordered_names]

    @staticmethod
    def _apply_minimum_wage_floor(source: dict[str, Any], result: dict[str, Any], columns: list[str], rules: dict[str, Any]) -> None:
        config = rules.get("minimum_wage_rule") or {}
        try:
            monthly_wage = CalculationEngine._decimal(config.get("monthly_minimum_wage"))
        except ValueError:
            return
        if monthly_wage <= 0:
            return
        net_ref = str(rules.get("net_income_field") or "").strip()
        if not net_ref:
            return
        net_key = net_ref if net_ref in result else net_ref.rsplit(".", 1)[-1]
        if net_key not in result:
            return
        try:
            current_net = CalculationEngine._decimal(result.get(net_key))
        except ValueError:
            return

        def value_for(ref: Any) -> Decimal:
            reference = str(ref or "").strip()
            if not reference:
                return Decimal("0")
            value = result.get(reference, source.get(reference))
            if value in (None, "") and "." in reference:
                short_name = reference.rsplit(".", 1)[-1]
                value = result.get(short_name, source.get(short_name))
            try:
                return CalculationEngine._decimal(value)
            except ValueError:
                return Decimal("0")

        standard_days = value_for(rules.get("standard_work_days_field"))
        # 如果配置了月度排班表，则以员工班次和核算月份对应的 JSON 记录为准；
        # 未匹配到时才回退到数据字段中的应出勤天数。
        schedule = rules.get("attendance_schedule") or []
        attendance_mode = str(rules.get("attendance_mode") or "custom")
        shift_value = str(CalculationEngine._value_for_text(rules.get("shift_field"), result, source) or "").strip().lower()
        period = str(rules.get("_period") or source.get("period") or source.get("_sys_period") or "")
        year = month = None
        period_match = re.search(r"(20\d{2})[-年/]?(\d{1,2})", period)
        if period_match:
            year, month = int(period_match.group(1)), int(period_match.group(2))
        if year and month and schedule:
            for item in schedule:
                try:
                    if int(item.get("year")) != year or int(item.get("month")) != month:
                        continue
                    is_single_rest = attendance_mode == "all_single" or (attendance_mode == "custom" and any(token in shift_value for token in ("单休", "做六休一", "six_one", "single")))
                    scheduled_days = item.get("single_rest_work_days" if is_single_rest else "double_rest_work_days")
                    if scheduled_days not in (None, ""):
                        standard_days = CalculationEngine._decimal(scheduled_days)
                    break
                except (TypeError, ValueError):
                    continue
        absence_days = max(Decimal("0"), value_for(rules.get("absence_days_field")))
        attendance_ratio = Decimal("1")
        if standard_days > 0:
            attendance_ratio = max(Decimal("0"), min(Decimal("1"), (standard_days - absence_days) / standard_days))
        full_ratio = CalculationEngine._safe_ratio(config.get("full_attendance_floor_ratio"), Decimal("1"))
        full_floor = monthly_wage * full_ratio
        actual_floor = full_floor
        if str(config.get("absence_floor_mode") or "pro_rata") == "pro_rata":
            actual_floor = full_floor * attendance_ratio
        # 只有当前收入低于配置的实际保底线才触发规则。
        if current_net >= actual_floor:
            return

        # 这些字段代表已从工资中扣除的考勤项目。将其加回即得到“满勤假定收入”，
        # 再在满勤基准上补足，最终仍保留原有扣减，符合“先补足、后扣减”的业务顺序。
        deduction_refs = (
            "absence_deduction", "attendance_deduction", "absence_pay_deduction",
            "sick_leave_deduction", "personal_leave_deduction", "late_early_deduction",
            "欠勤扣减", "缺勤扣减", "病假扣减", "事假扣减", "迟到早退扣减",
        )
        # 模板字段可以由用户自定义名称，因此同时识别带有“扣减/扣款/扣除”语义的
        # 输出字段；仅在字段名包含扣减语义时纳入，避免把“病假天数”等天数列当成金额。
        dynamic_deductions = [
            name for name in set(columns) | set(result)
            if name != net_key and any(token in str(name).lower() for token in ("deduction", "扣减", "扣款", "扣除"))
        ]
        deduction_refs = tuple(dict.fromkeys((*deduction_refs, *dynamic_deductions)))
        attendance_deductions = sum((abs(value_for(ref)) for ref in deduction_refs), Decimal("0"))
        full_attendance_income = current_net + attendance_deductions
        top_up = max(Decimal("0"), full_floor - full_attendance_income)
        if top_up <= 0:
            return
        result[net_key] = current_net + top_up
        for candidate in ("minimum_wage_top_up", "minimum_wage_adjustment", "pay_difference", "subsidy", "adjustment_deduction", "补差"):
            if candidate in columns:
                result[candidate] = value_for(candidate) + top_up
                break

    @staticmethod
    def _safe_ratio(value: Any, default: Decimal) -> Decimal:
        try:
            ratio = CalculationEngine._decimal(value)
            return max(Decimal("0"), ratio)
        except ValueError:
            return default

    @staticmethod
    def _value_for_reference(reference: Any, result: dict[str, Any], source: dict[str, Any]) -> Any:
        name = str(reference or "").strip()
        if name.startswith("temp."):
            return result.get(name[len("temp."):])
        value = result.get(name, source.get(name))
        if value in (None, "") and "." in name:
            short_name = name.rsplit(".", 1)[-1]
            value = result.get(short_name, source.get(short_name))
        return value

    @staticmethod
    def _value_for_text(reference: Any, result: dict[str, Any], source: dict[str, Any]) -> Any:
        name = str(reference or "").strip()
        value = result.get(name, source.get(name))
        if value in (None, "") and "." in name:
            short_name = name.rsplit(".", 1)[-1]
            value = result.get(short_name, source.get(short_name))
        return value

    @staticmethod
    def _rule_label(rule: dict[str, Any], fallback: str) -> str:
        return str(rule.get("project") or rule.get("logicName") or rule.get("name") or fallback)

    @staticmethod
    def _execute_approved_rule(rule_executor: RuleExecutionSandbox | None, code: str, source: dict[str, Any], result: dict[str, Any], rule_label: str = "未命名规则") -> dict[str, Any] | None:
        if rule_executor is None:
            raise ValueError("规则执行器未初始化，已拒绝在主服务进程执行核算代码")
        return rule_executor.execute(code, source, result, rule_label)

    @staticmethod
    def _normalize_output_fields(fields: list[dict[str, Any]]) -> list[dict[str, Any]]:
        return [{"name": field["name"], "sqlite_type": field.get("sqlite_type") or field.get("type") or "TEXT", "display_name": field.get("display_name") or field.get("name")} for field in fields]

    @staticmethod
    def _decimal(value: Any) -> Decimal:
        try:
            if value in (None, ""):
                return Decimal("0")
            parsed = Decimal(str(value).replace(",", ""))
            if not parsed.is_finite():
                raise InvalidOperation("金额不是有限数")
            return parsed.quantize(Decimal("0.0001"), rounding=ROUND_HALF_UP)
        except (TypeError, ValueError, InvalidOperation):
            raise ValueError(f"金额字段存在非法数值: {value}")

    @staticmethod
    def _db_value(value: Any) -> Any:
        return format(value.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP), "f") if isinstance(value, Decimal) else value

    @staticmethod
    def _is_amount_field(name: str) -> bool:
        return any(token in name.lower() for token in ("amount", "salary", "commission", "payable", "target"))

    @staticmethod
    def _rule_policy(rules: dict[str, Any]) -> dict[str, Decimal]:
        descriptions = [str(item.get("description", "")) for scope in ("global", "table", "custom", "statutory") for item in rules.get(scope, []) if item.get("status") == "已解析"]
        text = " ".join(descriptions)
        percentages = [Decimal(match) / Decimal("100") for match in re.findall(r"(\d+(?:\.\d+)?)\s*%", text)]
        threshold = percentages[0] if len(percentages) >= 4 else Decimal("0.8")
        base_rate = percentages[-2] if len(percentages) >= 2 else Decimal("0.02")
        above_rate = percentages[-1] if percentages else Decimal("0.04")
        return {"minimum_rate_threshold": threshold, "base_rate": base_rate, "above_target_rate": above_rate}

    @staticmethod
    def _quote(identifier: str) -> str:
        if not identifier.replace("_", "a").isalnum() or identifier[0].isdigit():
            raise ValueError(f"数据库标识符不合法: {identifier}")
        return '"' + identifier + '"'
