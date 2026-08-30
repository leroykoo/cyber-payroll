import { useEffect, useMemo, useRef, useState } from "react";
import {
  Archive,
  ArrowRight,
  BadgeDollarSign,
  BookOpen,
  Bot,
  Boxes,
  Braces,
  Check,
  ChevronLeft,
  ChevronDown,
  ChevronRight,
  CircleCheck,
  Code2,
  Database,
  FileArchive,
  FileCheck2,
  FileOutput,
  FileUp,
  History,
  Info,
  LayoutDashboard,
  LoaderCircle,
  GripVertical,
  MoreHorizontal,
  Play,
  Plus,
  RefreshCw,
  ScrollText,
  Settings,
  ShieldCheck,
  Table2,
  Trash2,
  Upload,
  Workflow,
  X,
} from "lucide-react";
import * as XLSX from "xlsx";
import { createPortal } from "react-dom";
import { createRoot } from "react-dom/client";
import statutoryHolidayDefaults from "./defaults/statutory_holidays.json";
import sickLeaveDefaults from "./defaults/sick_leave_policy.json";
import minimumWageDefaults from "./defaults/minimum_wage_policy.json";
import attendanceScheduleDefaults from "./defaults/attendance_schedule.json";
import "./styles.css";

function localApiFetch(url, options = {}) {
  const organizationId = localStorage.getItem("payroll-current-organization") || "default_org";
  return fetch(url, {
    ...options,
    headers: { ...(options.headers || {}), "X-Organization-ID": organizationId },
  });
}

function ModalPortal({ children }) {
  return createPortal(children, document.body);
}

const OUTPUT_REFERENCE_PATTERN = /@output\.([a-z][a-z0-9_]*)/g;
const TEMP_REFERENCE_PATTERN = /@temp\.([a-z][a-z0-9_]*)/g;

function getOutputReferences(description) {
  return [...String(description || "").matchAll(OUTPUT_REFERENCE_PATTERN)].map((match) => match[1]);
}
function getTemporaryReferences(description) { return [...String(description || "").matchAll(TEMP_REFERENCE_PATTERN)].map((match) => match[1]); }
function getTemporaryDependencyIssues(fields) {
  const byName = new Map(fields.map((field) => [field.name, field])); const issues = []; const visiting = new Set(); const visited = new Set();
  const visit = (name, path = []) => { if (visiting.has(name)) { const start = path.indexOf(name); issues.push(`临时字段计算逻辑存在循环引用：${[...path.slice(start), name].map((item) => byName.get(item)?.display_name || item).join(" → ")}`); return; } if (visited.has(name)) return; visiting.add(name); const field = byName.get(name); if (/@output\./i.test(field?.description || "")) issues.push(`临时字段“${field?.display_name || name}”不能引用 @output 字段`); getTemporaryReferences(field?.description).forEach((ref) => { if (!byName.has(ref)) issues.push(`临时字段“${field?.display_name || name}”引用了不存在的临时字段 @temp.${ref}`); else visit(ref, [...path, name]); }); visiting.delete(name); visited.add(name); };
  fields.forEach((field) => visit(field.name)); return [...new Set(issues)];
}

function getOutputDependencyIssues(fields, rules) {
  const fieldNames = new Set(fields.map((field) => field.name));
  const displayNames = Object.fromEntries(fields.map((field) => [field.name, field.display_name || field.name]));
  const issues = [];
  const dependencies = new Map();
  fieldNames.forEach((fieldName) => {
    const rule = rules[fieldName] || {};
    const refs = rule.mode === "source" && String(rule.source_ref || "").startsWith("output.")
      ? [String(rule.source_ref).slice("output.".length)]
      : getOutputReferences(rule.description);
    refs.forEach((ref) => { if (!fieldNames.has(ref)) issues.push(`输出字段“${displayNames[fieldName]}”引用了不存在的输出字段 @output.${ref}`); });
    dependencies.set(fieldName, refs.filter((ref) => fieldNames.has(ref)));
  });
  const visiting = new Set();
  const visited = new Set();
  const visit = (fieldName, path) => {
    if (visiting.has(fieldName)) {
      const start = path.indexOf(fieldName);
      issues.push(`输出字段计算逻辑存在循环引用：${[...path.slice(start), fieldName].map((name) => displayNames[name]).join(" → ")}`);
      return;
    }
    if (visited.has(fieldName)) return;
    visiting.add(fieldName);
    (dependencies.get(fieldName) || []).forEach((dependency) => visit(dependency, [...path, fieldName]));
    visiting.delete(fieldName);
    visited.add(fieldName);
  };
  fieldNames.forEach((fieldName) => visit(fieldName, []));
  return [...new Set(issues)];
}

function orderGenerationTargets(targets) {
  const targetByKey = new Map(targets.map((target) => [target.key, target]));
  const ordered = [];
  const visiting = new Set();
  const visited = new Set();
  const visit = (target) => {
    if (visited.has(target.key)) return;
    if (visiting.has(target.key)) return;
    visiting.add(target.key);
    [...(target.output_dependencies || []).map((dependency) => `output:${dependency}`), ...(target.temp_dependencies || []).map((dependency) => `temp:${dependency}`)].forEach((dependency) => {
      const dependencyTarget = targetByKey.get(dependency);
      if (dependencyTarget) visit(dependencyTarget);
    });
    visiting.delete(target.key);
    visited.add(target.key);
    ordered.push(target);
  };
  targets.filter((target) => target.key.startsWith("temp:") || target.key.startsWith("output:")).forEach(visit);
  targets.filter((target) => !target.key.startsWith("temp:") && !target.key.startsWith("output:")).forEach((target) => ordered.push(target));
  return ordered;
}

function inspectGeneratedPythonCode(code, ruleLabel) {
  const lines = String(code || "").split(/\r?\n/);
  const issues = [];
  const blockedPatterns = [
    [/^\s*import\b/, "import 导入"],
    [/^\s*from\s+.+\s+import\b/, "from ... import 导入"],
    [/^\s*try\s*:/, "try/except"],
    [/^\s*with\s+/, "with"],
    [/^\s*lambda\b/, "lambda"],
    [/^\s*global\b/, "global"],
    [/^\s*nonlocal\b/, "nonlocal"],
    [/^\s*async\s+def\b/, "异步函数"],
    [/^\s*await\b/, "await"],
  ];
  lines.forEach((line, index) => {
    const blocked = blockedPatterns.find(([pattern]) => pattern.test(line));
    if (blocked) issues.push(`规则“${ruleLabel}”第 ${index + 1} 行包含不允许执行的 Python 语句：${blocked[1]}；代码：${line.trim()}`);
    const call = line.match(/\b(eval|exec|open|__import__|compile|input)\s*\(/);
    if (call) issues.push(`规则“${ruleLabel}”第 ${index + 1} 行调用了不允许的函数：${call[1]}()`);
  });
  return issues;
}

const dataTables = [
  {
    name: "薪资花名册",
    technical: "employee_master",
    excelFile: "员工主数据模板.xlsx",
    selectedFields: 12,
    fields: 12,
    type: "薪资基础资料",
    schemaStatus: "已确认",
    importStatus: "待导入",
    lastImport: null,
    records: "326 条",
    updated: "2026-08-14 18:20",
  },
  {
    name: "固定薪资",
    technical: "fixed_salary",
    excelFile: "固定薪资模板.xlsx",
    selectedFields: 11,
    fields: 11,
    type: "薪资基础资料",
    schemaStatus: "待确认",
    importStatus: "待导入",
    lastImport: null,
    records: "0 条",
    updated: "尚未导入",
  },
];
const payrollRequiredItems = [
  {
    id: "roster",
    title: "薪资花名册",
    description: "员工身份、用工状态与计薪基础信息。",
    fields: [
      { key: "employee_id", label: "员工编号", type: "文本", required: true },
      { key: "company", label: "公司", type: "文本", required: true },
      { key: "employee_name", label: "姓名", type: "文本", required: true },
      { key: "department", label: "部门", type: "文本", required: false },
      { key: "position", label: "岗位", type: "文本", required: false },
      { key: "hire_date", label: "入职日期", type: "日期", required: true },
      { key: "termination_date", label: "离职日期", type: "日期", required: false },
      { key: "employment_status", label: "用工状态", type: "文本", required: false, default: "正式" },
      { key: "probation_rate", label: "试用期比例", type: "数值", required: false, default: 0.8 },
      { key: "employment_type", label: "雇佣类型", type: "文本", required: false, default: "全职" },
      { key: "pay_cycle", label: "计薪周期", type: "文本", required: false, default: "月薪" },
      { key: "standard_work_days", label: "应出勤天数", type: "数值", required: false, default: "按核算月份双休" },
    ],
  },
  {
    id: "fixed_salary",
    title: "固定薪资",
    description: "基本月薪、固定津贴及社会保险缴费基数。",
    fields: [
      { key: "employee_id", label: "员工编号", type: "文本", required: true },
      { key: "period", label: "期间", type: "文本", required: true },
      { key: "base_salary", label: "基本月薪", type: "数值", required: true },
      { key: "fixed_allowance", label: "固定津贴", type: "数值", required: false },
      { key: "position_allowance", label: "岗位津贴", type: "数值", required: false },
      { key: "overtime_base", label: "加班工资基数", type: "数值", required: false },
      { key: "social_security_base", label: "社保缴费基数", type: "数值", required: false },
      { key: "housing_fund_base", label: "公积金缴费基数", type: "数值", required: false },
      { key: "effective_from", label: "生效日期", type: "日期", required: true },
      { key: "effective_to", label: "失效日期", type: "日期", required: false },
      { key: "salary_status", label: "薪资状态", type: "文本", required: true },
    ],
  },
  {
    id: "attendance",
    title: "出勤与请假",
    description: "用于按出勤、缺勤、请假和加班情况计算应发薪资。",
    fields: [
      { key: "employee_id", label: "员工编号", type: "文本", required: true },
      { key: "period", label: "期间", type: "文本", required: true },
      { key: "standard_work_days", label: "应出勤天数", type: "数值", required: true },
      { key: "actual_work_days", label: "实际出勤天数", type: "数值", required: true },
      { key: "leave_days", label: "请假天数", type: "数值", required: false },
      { key: "absence_days", label: "缺勤天数", type: "数值", required: false },
      { key: "overtime_hours", label: "加班小时", type: "数值", required: false },
    ],
  },
  {
    id: "other_pay_items",
    title: "奖金与扣款",
    description: "承接奖金、补贴、代扣和其他影响实发工资的项目。",
    fields: [
      { key: "employee_id", label: "员工编号", type: "文本", required: true },
      { key: "period", label: "期间", type: "文本", required: true },
      { key: "bonus_amount", label: "奖金金额", type: "数值", required: false },
      { key: "subsidy_amount", label: "专项补贴", type: "数值", required: false },
      { key: "deduction_amount", label: "其他扣款", type: "数值", required: false },
      { key: "remark", label: "备注", type: "文本", required: false },
    ],
  },
];
// 核算项目只应来自当前组织已配置的核算模型；新组织没有配置时保持空状态，避免展示历史示例。
const calculationItems = [];
const navItems = [
  { id: "overview", label: "总览", icon: LayoutDashboard },
  { id: "output", label: "输出目标", icon: FileOutput },
  { id: "data", label: "数据", icon: Database },
  {
    id: "calculation",
    label: "核算设计",
    icon: Play,
    children: [
      { id: "run", label: "核算逻辑配置", icon: Workflow },
      { id: "output-config", label: "输出字段配置", icon: FileOutput },
    ],
  },
  { id: "data-import", label: "数据导入", icon: FileUp },
  { id: "audit", label: "历史 / 审计", icon: History },
  { id: "settings", label: "设置", icon: Settings },
  { id: "about", label: "关于", icon: Info },
];
const aiProviders = {
  deepseek: { label: "DeepSeek", baseUrl: "https://api.deepseek.com/v1", defaultModel: "deepseek-chat", models: ["deepseek-chat", "deepseek-reasoner"] },
  glm: { label: "智谱 GLM", baseUrl: "https://open.bigmodel.cn/api/paas/v4", defaultModel: "glm-4.5", models: ["glm-4.5", "glm-4.5-air", "glm-4.5-flash"] },
  openai: { label: "ChatGPT / OpenAI", baseUrl: "https://api.openai.com/v1", defaultModel: "gpt-5", models: ["gpt-5", "gpt-5-mini", "gpt-4.1"] },
  custom: { label: "自定义兼容 API", baseUrl: "", defaultModel: "", models: [] },
};
const fieldAliases = {
  员工编号: "employee_id",
  员工ID: "employee_id",
  工号: "employee_id",
  employee_id: "employee_id",
  公司: "company",
  company: "company",
  员工姓名: "employee_name",
  姓名: "employee_name",
  employee_name: "employee_name",
  期间: "period",
  月份: "period",
  period: "period",
  基本工资: "base_salary",
  基础工资: "base_salary",
  base_salary: "base_salary",
  销售金额: "sales_amount",
  销售额: "sales_amount",
  sales_amount: "sales_amount",
  回款金额: "collection_amount",
  collection_amount: "collection_amount",
  提成金额: "commission_amount",
  commission_amount: "commission_amount",
  部门: "department",
  岗位: "position",
  入职日期: "hire_date",
  离职日期: "termination_date",
  用工状态: "employment_status",
  试用期比例: "probation_rate",
  雇佣类型: "employment_type",
  计薪周期: "pay_cycle",
  应出勤天数: "standard_work_days",
  基本月薪: "base_salary",
  固定津贴: "fixed_allowance",
  岗位津贴: "position_allowance",
  加班工资基数: "overtime_base",
  社保缴费基数: "social_security_base",
  公积金缴费基数: "housing_fund_base",
  生效日期: "effective_from",
  失效日期: "effective_to",
  薪资状态: "salary_status",
  实际出勤天数: "actual_work_days",
  请假天数: "leave_days",
  缺勤天数: "absence_days",
  加班小时: "overtime_hours",
  奖金金额: "bonus_amount",
  专项补贴: "subsidy_amount",
  其他扣款: "deduction_amount",
  备注: "remark",
  薪资标准: "salary_standard",
  绩效标准: "performance_standard",
  绩效金额: "performance_amount",
  应发工资: "gross_pay",
  实发工资: "net_pay",
  基本工资: "base_salary",
  年度: "year",
  年: "year",
  月: "month",
  UID: "uid",
  uid: "uid",
  编号: "id",
  日期: "date",
  金额: "amount",
  数量: "quantity",
  天数: "days",
  小时: "hours",
  入离职缺勤天数: "employment_absence_days",
  事假天数: "personal_leave_days",
  病假天数: "sick_leave_days",
  "迟到/早退小时": "late_early_hours",
  带薪假天数: "paid_leave_days",
  法定假日加班天数: "holiday_overtime_days",
  缺勤扣减: "absence_deduction",
  事假扣减: "personal_leave_deduction",
  病假扣减: "sick_leave_deduction",
  "迟到/早退扣减": "late_early_deduction",
  绩效: "performance_pay",
  奖金: "bonus",
  补贴: "subsidy",
  法定假日加班费: "holiday_overtime_pay",
  补差: "pay_difference",
  "调整/扣减": "adjustment_deduction",
  税前应付: "gross_pay_before_tax",
  应付工资: "payable_salary",
  综合薪资: "total_salary",
  总薪资: "total_salary",
  薪资合计: "salary_total",
  应付合计: "payable_total",
  社保: "social_security",
  公积金: "housing_fund",
  个人所得税: "individual_income_tax",
  个税: "individual_income_tax",
  税后实发: "net_pay_after_tax",
  实发: "net_pay",
  加班费: "overtime_pay",
  法定假日加班: "holiday_overtime",
  病假: "sick_leave",
  事假: "personal_leave",
  "迟到/早退": "late_early",
  考勤扣款: "attendance_deduction",
  扣款合计: "deduction_total",
};
const suggestFieldName = (name) => fieldAliases[String(name).trim()] || "";
const outputNameTokens = Object.entries({
  医疗附加: "medical_additional",
  法定假日: "holiday",
  法定: "statutory",
  入离职: "employment",
  迟到: "late",
  早退: "early",
  缺勤: "absence",
  事假: "personal_leave",
  病假: "sick_leave",
  带薪假: "paid_leave",
  加班: "overtime",
  扣减: "deduction",
  调整: "adjustment",
  税前: "before_tax",
  税后: "after_tax",
  应付: "payable",
  应发: "gross_pay",
  实发: "net_pay",
  薪资: "salary",
  工资: "salary",
  绩效: "performance",
  奖金: "bonus",
  补贴: "subsidy",
  补差: "difference",
  养老: "pension",
  工伤: "work_injury",
  失业: "unemployment",
  医疗: "medical",
  公积金: "housing_fund",
  个税: "individual_income_tax",
  企业: "employer",
  个人: "employee",
  年度: "year",
  月份: "month",
  日期: "date",
  天数: "days",
  小时: "hours",
  金额: "amount",
  标准: "standard",
  合计: "total",
}).sort(([left], [right]) => right.length - left.length);
const labelFingerprint = (label) => Array.from(String(label || "")).reduce((value, character) => ((value * 31) + character.codePointAt(0)) >>> 0, 7).toString(36);
const makeOutputFieldName = (label, index, usedNames) => {
  const original = String(label || "").trim();
  const alias = suggestFieldName(original);
  const normalized = original.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
  let generated = alias || normalized;
  if (!generated || !/^[a-z_]/.test(generated)) {
    let remaining = original.replace(/[（）()【】\[\]{}]/g, " ").replace(/[·、,，/\\-]/g, " ");
    const parts = [];
    outputNameTokens.forEach(([word, token]) => {
      if (!remaining.includes(word)) return;
      parts.push(token);
      remaining = remaining.split(word).join(" ");
    });
    const hasUntranslatedChinese = /[\u3400-\u9fff]/.test(remaining);
    generated = parts.length ? parts.join("_") : `column_${index + 1}`;
    if (hasUntranslatedChinese || !parts.length) generated = `${generated}_${labelFingerprint(original)}`;
  }
  const base = generated.replace(/_+/g, "_").replace(/^_+|_+$/g, "").slice(0, 63);
  let candidate = base;
  let suffix = 2;
  while (usedNames.has(candidate)) {
    const marker = `_${suffix++}`;
    candidate = `${base.slice(0, 63 - marker.length)}${marker}`;
  }
  usedNames.add(candidate);
  return candidate;
};
const tableMappings = {
  employee_master: [
    {
      excel: "员工编号",
      db: "employee_id",
      excelType: "文本",
      dbType: "TEXT",
      transform: "无需转换",
      required: true,
    },
    {
      excel: "员工姓名",
      db: "employee_name",
      excelType: "文本",
      dbType: "TEXT",
      transform: "无需转换",
      required: true,
    },
    {
      excel: "部门",
      db: "department",
      excelType: "文本",
      dbType: "TEXT",
      transform: "无需转换",
      required: false,
    },
    {
      excel: "基本月薪",
      db: "base_salary",
      excelType: "数值",
      dbType: "NUMERIC",
      transform: "文本转数值",
      required: true,
    },
    {
      excel: "入职日期",
      db: "hire_date",
      excelType: "日期",
      dbType: "DATE",
      transform: "日期标准化",
      required: false,
    },
    { excel: "岗位", db: "position", excelType: "文本", dbType: "TEXT", transform: "无需转换", required: false },
    { excel: "离职日期", db: "termination_date", excelType: "日期", dbType: "DATE", transform: "日期标准化", required: false },
    { excel: "用工状态", db: "employment_status", excelType: "文本", dbType: "TEXT", transform: "无需转换", required: true },
    { excel: "试用期比例", db: "probation_rate", excelType: "数值", dbType: "NUMERIC", transform: "文本转数值", required: false, defaultValue: "0.8000" },
    { excel: "雇佣类型", db: "employment_type", excelType: "文本", dbType: "TEXT", transform: "无需转换", required: true },
    { excel: "计薪周期", db: "pay_cycle", excelType: "文本", dbType: "TEXT", transform: "无需转换", required: true, defaultValue: "月薪" },
    { excel: "应出勤天数", db: "standard_work_days", excelType: "数值", dbType: "NUMERIC", transform: "文本转数值", required: true },
  ],
  fixed_salary: [
    { excel: "员工编号", db: "employee_id", excelType: "文本", dbType: "TEXT", transform: "无需转换", required: true },
    { excel: "期间", db: "period", excelType: "文本", dbType: "TEXT", transform: "无需转换", required: true },
    { excel: "基本月薪", db: "base_salary", excelType: "数值", dbType: "NUMERIC", transform: "文本转数值", required: true },
    { excel: "固定津贴", db: "fixed_allowance", excelType: "数值", dbType: "NUMERIC", transform: "文本转数值", required: false },
    { excel: "岗位津贴", db: "position_allowance", excelType: "数值", dbType: "NUMERIC", transform: "文本转数值", required: false },
    { excel: "加班工资基数", db: "overtime_base", excelType: "数值", dbType: "NUMERIC", transform: "文本转数值", required: false },
    { excel: "社保缴费基数", db: "social_security_base", excelType: "数值", dbType: "NUMERIC", transform: "文本转数值", required: false },
    { excel: "公积金缴费基数", db: "housing_fund_base", excelType: "数值", dbType: "NUMERIC", transform: "文本转数值", required: false },
    { excel: "生效日期", db: "effective_from", excelType: "日期", dbType: "DATE", transform: "日期标准化", required: true },
    { excel: "失效日期", db: "effective_to", excelType: "日期", dbType: "DATE", transform: "日期标准化", required: false },
    { excel: "薪资状态", db: "salary_status", excelType: "文本", dbType: "TEXT", transform: "无需转换", required: true, defaultValue: "有效" },
  ],
  sales_detail: [
    {
      excel: "员工编号",
      db: "employee_id",
      excelType: "文本",
      dbType: "TEXT",
      transform: "无需转换",
      required: true,
    },
    {
      excel: "期间",
      db: "period",
      excelType: "文本",
      dbType: "TEXT",
      transform: "无需转换",
      required: true,
    },
    {
      excel: "销售金额",
      db: "sales_amount",
      excelType: "文本",
      dbType: "REAL",
      transform: "文本转数值",
      required: true,
    },
    {
      excel: "订单编号",
      db: "order_id",
      excelType: "文本",
      dbType: "TEXT",
      transform: "无需转换",
      required: false,
    },
    {
      excel: "来源文件",
      db: "source_file",
      excelType: "系统生成",
      dbType: "TEXT",
      transform: "系统补充",
      required: false,
    },
    {
      excel: "系统批次号",
      db: "_sys_batch_id",
      excelType: "系统生成",
      dbType: "TEXT",
      transform: "系统补充",
      required: true,
    },
  ],
  collection_detail: [
    {
      excel: "员工编号",
      db: "employee_id",
      excelType: "文本",
      dbType: "TEXT",
      transform: "无需转换",
      required: true,
    },
    {
      excel: "期间",
      db: "period",
      excelType: "文本",
      dbType: "TEXT",
      transform: "无需转换",
      required: true,
    },
    {
      excel: "回款金额",
      db: "collection_amount",
      excelType: "文本",
      dbType: "REAL",
      transform: "文本转数值",
      required: true,
    },
    {
      excel: "订单编号",
      db: "order_id",
      excelType: "文本",
      dbType: "TEXT",
      transform: "无需转换",
      required: false,
    },
  ],
  sales_target: [
    {
      excel: "员工编号",
      db: "employee_id",
      excelType: "文本",
      dbType: "TEXT",
      transform: "无需转换",
      required: true,
    },
    {
      excel: "期间",
      db: "period",
      excelType: "文本",
      dbType: "TEXT",
      transform: "无需转换",
      required: true,
    },
    {
      excel: "销售目标",
      db: "target_amount",
      excelType: "文本",
      dbType: "REAL",
      transform: "文本转数值",
      required: true,
    },
  ],
};

function App() {
  const [page, setPage] = useState("overview");
  const [toast, setToast] = useState("");
  const [tables, setTables] = useState(dataTables);
  const [logic, setLogic] = useState(
    "销售明细通过 @sales_detail.employee_id 关联员工主数据。按员工和期间汇总销售金额，低于目标 80% 不计提；80% 至 100% 按 2%；超过目标的部分按 4%。回款系数根据实际回款金额计算，退款金额从当期销售额中扣除。",
  );
  const [selectedTable, setSelectedTable] = useState("");
  const [customOutputs, setCustomOutputs] = useState([]);
  const [logicValidated, setLogicValidated] = useState(false);
  const [aiConfig, setAiConfig] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem("payroll-ai-config")) || { provider: "deepseek", baseUrl: aiProviders.deepseek.baseUrl, model: aiProviders.deepseek.defaultModel, apiKey: "", models: aiProviders.deepseek.models };
    } catch {
      return { provider: "deepseek", baseUrl: aiProviders.deepseek.baseUrl, model: aiProviders.deepseek.defaultModel, apiKey: "", models: aiProviders.deepseek.models };
    }
  });
  const notify = (message) => {
    setToast(message);
    window.setTimeout(() => setToast(""), 2600);
  };
  useEffect(() => {
    let active = true;
    localApiFetch("http://127.0.0.1:8787/api/data/pages")
      .then((response) => response.ok ? response.json() : Promise.reject(new Error("数据表列表读取失败")))
      .then((payload) => {
        if (!active || !Array.isArray(payload.items)) return;
        setTables(payload.items.map(toClientTable));
      })
      .catch(() => {});
    return () => { active = false; };
  }, []);
  return (
    <div className="app-shell">
      <Sidebar page={page} onChange={setPage} />
      <main className="main-content">
        <Topbar onNotify={notify} />
        {page === "overview" && (
          <Overview tables={tables} logic={logic} setLogic={setLogic} logicValidated={logicValidated} onNotify={notify} />
        )}
        {page === "data" && (
          <DataPage
            tables={tables}
            setTables={setTables}
            selected={selectedTable}
            setSelected={setSelectedTable}
            onNotify={notify}
          />
        )}
        {page === "data-import" && (
          <DataImportPage tables={tables} setTables={setTables} onNotify={notify} onNavigate={setPage} />
        )}
        {page === "output" && <OutputPage onNotify={notify} customOutputs={customOutputs} setCustomOutputs={setCustomOutputs} />}
        {page === "output-config" && <OutputFieldRulesPage onNotify={notify} />}
        {page === "run" && <RunPage onNotify={notify} customOutputs={customOutputs} setCustomOutputs={setCustomOutputs} logicValidated={logicValidated} setLogicValidated={setLogicValidated} />}
        {page === "audit" && <AuditPage onNotify={notify} />}
        {page === "settings" && <SettingsPage config={aiConfig} setConfig={setAiConfig} onNotify={notify} />}
        {page === "about" && <AboutPage />}
      </main>
      {toast && (
        <div className="toast">
          <CircleCheck size={17} />
          {toast}
        </div>
      )}
    </div>
  );
}

function AboutPage() {
  return (
    <section className="page-frame about-page">
      <div className="page-heading about-heading">
        <div>
          <div className="about-eyebrow"><Info size={15} /> 关于 Cyber Payroll</div>
          <h1>让薪酬核算回到可理解、可复核的本地程序</h1>
          <p>一个基于本地 SQL 与 Python 的薪酬 / 提成数据计算工具，用程序处理 Excel 中杂乱的数据来源和复杂的计算逻辑。</p>
        </div>
      </div>

      <div className="about-layout">
        <section className="panel about-intro-card">
          <div className="about-card-heading">
            <div className="about-card-icon"><BadgeDollarSign size={20} /></div>
            <div>
              <h2>项目介绍</h2>
              <p>从表格结构到最终结果，建立一条本地、清晰、可追踪的薪酬计算流程。</p>
            </div>
          </div>
          <p>Cyber Payroll 本质上是一个基于本地 SQL 与 Python 的薪酬数据计算工具，目的是通过程序解决使用 Excel 计算薪酬时，由于数据来源杂乱、表格结构复杂以及业务逻辑多变而产生的大量重复和繁琐操作。</p>
          <p>项目采用本地 SQLite 作为数据存储基础，通过解析 Excel 文件表头和字段结构，在本地建立对应的数据库表；再利用大模型理解用户通过自然语言描述的薪酬计算逻辑，协助设计计算思路并生成 Python 计算程序；最后导入完整的真实薪酬数据，由已经确认和发布的 Python 代码在本地完成计算。</p>
        </section>

        <aside className="about-side-stack">
          <section className="panel about-contact-card">
            <div className="about-card-heading">
              <div className="about-card-icon contact"><Info size={20} /></div>
              <div>
                <h2>作者与联系方式</h2>
                <p>欢迎交流项目想法、使用体验和改进建议。</p>
              </div>
            </div>
            <div className="about-contact-list">
              <div><span>作者</span><strong>LeroyKoo</strong></div>
              <div><span>邮箱</span><a href="mailto:leroy.koo@hotmail.com">leroy.koo@hotmail.com</a></div>
              <div><span>微信</span><strong>18516696831</strong></div>
            </div>
          </section>
          <section className="about-principle-note">
            <ShieldCheck size={20} />
            <div>
              <strong>本地数据与版本隔离</strong>
              <p>大模型负责辅助理解和设计，不参与真实薪酬数据的最终计算。</p>
            </div>
          </section>
        </aside>
      </div>

      <section className="panel about-guide">
        <div className="about-guide-heading">
          <div className="about-card-icon guide"><BookOpen size={20} /></div>
          <div>
            <h2>使用说明</h2>
            <p>使用本程序前，建议先了解数据库中的几个基础概念和 Cyber Payroll 的核算流程。</p>
          </div>
        </div>
        <div className="about-concepts">
          <div><strong>主键</strong><p>数据库里每一条记录的“唯一身份证号”。例如钉钉导出的通讯录中，即使公司有两个人都叫“张三”，每个张三的 UID 也不同，这个 UID 就是主键。主键也是连接不同数据表、关联同一员工信息的桥梁。</p></div>
          <div><strong>表结构</strong><p>数据库表的组成方式，包括一张表有多少个字段、字段的前后顺序以及每个字段的定义。</p></div>
          <div><strong>字段</strong><p>数据库表里的一列。每个字段都有对应的数据格式，就像 Excel 表中的每一列，需要明确它是常规文本、日期、数值还是货币等格式。</p></div>
        </div>
        <div className="about-steps">
          <div className="about-step"><span>1</span><div><strong>确定输出表结构</strong><p>在“输出目标”页面中，确定最终需要输出的 Excel 表结构、字段和顺序。</p></div></div>
          <div className="about-step"><span>2</span><div><strong>上传数据源表结构</strong><p>在“数据”页面中上传参与计算的数据源表模板。这里先上传表结构即可，目的是让系统了解字段，并为后续生成 Python 代码做准备。</p></div></div>
          <div className="about-step"><span>3</span><div><strong>配置核算逻辑</strong><p>在“核算逻辑配置”页面中描述数据计算逻辑，可以使用自然语言告诉 AI 如何计算，也可以使用 <code>@表名.字段</code> 定位具体字段，同时完成输出表各字段的取值或计算规则。完成这一步后，AI 的主要辅助工作基本结束。</p></div></div>
          <div className="about-step"><span>4</span><div><strong>导入真实数据并计算</strong><p>在“数据导入”页面上传完整数据，由已确认的 Python 代码在本地完成数据计算并输出结果。</p></div></div>
        </div>
      </section>

      <section className="about-principles">
        <div className="panel about-principle-card">
          <Database size={20} />
          <h3>数据留在本地</h3>
          <p>真实薪酬数据存储在组织专属 SQLite 数据库中，由本地 Python 读取和处理。</p>
        </div>
        <div className="panel about-principle-card">
          <Bot size={20} />
          <h3>AI 只做辅助</h3>
          <p>大模型用于解析结构、理解自然语言规则和生成程序，不代替本地程序执行核算。</p>
        </div>
        <div className="panel about-principle-card">
          <Code2 size={20} />
          <h3>程序保证一致</h3>
          <p>通过已确认和发布的 Python 代码完成计算，降低 AI 幻觉、随机性和数据漂移风险。</p>
        </div>
      </section>
    </section>
  );
}

function Sidebar({ page, onChange }) {
  const activePage = navItems.flatMap((item) => item.children || [item]).find((item) => item.id === page);
  return (
    <aside className="sidebar">
      <div className="brand">
        <span className="brand-symbol">
          <BadgeDollarSign size={20} />
        </span>
        <span className="brand-wordmark"><b>Cyber</b><span>Payroll</span></span>
      </div>
      <div className="workspace-name">
        <span>当前页面</span>
        <strong>{activePage?.label || "总览"}</strong>
      </div>
      <nav>
        {navItems.map(({ id, label, icon: Icon, children }) => children ? (
          <div key={id} className={`nav-group ${children.some((item) => item.id === page) ? "active" : ""}`}>
            <div className="nav-group-label">
              <Icon size={18} />
              {label}
            </div>
            <div className="nav-subnav">
              {children.map(({ id: childId, label: childLabel, icon: ChildIcon }) => (
                <button
                  key={childId}
                  className={`nav-item nav-subitem ${page === childId ? "active" : ""}`}
                  onClick={() => onChange(childId)}
                >
                  <ChildIcon size={16} />
                  {childLabel}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <button
            key={id}
            className={`nav-item ${page === id ? "active" : ""}`}
            onClick={() => onChange(id)}
          >
            <Icon size={18} />
            {label}
          </button>
        ))}
      </nav>
      <div className="sidebar-bottom">
        <button className="support-link">
          <ShieldCheck size={16} />
          本地数据与版本隔离
        </button>
      </div>
    </aside>
  );
}
function Topbar({ onNotify }) {
  const [organizations, setOrganizations] = useState(() => { try { const stored = JSON.parse(localStorage.getItem("payroll-organizations")); return Array.isArray(stored) && stored.length ? stored : [{ organization_id: "default_org", display_name: "立天世纪" }]; } catch { return [{ organization_id: "default_org", display_name: "立天世纪" }]; } });
  const [currentOrganization, setCurrentOrganization] = useState(() => localStorage.getItem("payroll-current-organization") || "default_org");
  const [organizationDialog, setOrganizationDialog] = useState(false);
  const [newOrganization, setNewOrganization] = useState("");
  const switchOrganization = (organizationId) => {
    if (!organizationId || organizationId === currentOrganization) return;
    const next = organizations.find((organization) => organization.organization_id === organizationId);
    if (!next) return;
    setCurrentOrganization(organizationId);
    localStorage.setItem("payroll-current-organization", organizationId);
    // 页面各功能区拥有自己的本地状态；切换组织时重载应用，避免旧组织数据残留。
    onNotify(`正在切换到组织：${next.display_name}`);
    window.setTimeout(() => window.location.reload(), 120);
  };
  useEffect(() => {
    fetch("http://127.0.0.1:8787/api/organizations").then((response) => response.ok ? response.json() : Promise.reject(new Error("组织服务不可用"))).then((payload) => {
      if (!payload.items?.length) return;
      const normalizedItems = payload.items.map((item) => item.organization_id === "default_org" ? { ...item, display_name: "立天世纪" } : item);
      setOrganizations(normalizedItems);
      const saved = normalizedItems.some((item) => item.organization_id === currentOrganization) ? currentOrganization : normalizedItems[0].organization_id;
      setCurrentOrganization(saved);
      localStorage.setItem("payroll-organizations", JSON.stringify(normalizedItems));
      localStorage.setItem("payroll-current-organization", saved);
    }).catch(() => {});
  }, []);
  const addOrganization = () => {
    const name = newOrganization.trim();
    if (!name) { onNotify("请输入组织名称"); return; }
    const organizationId = name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").replace(/^\d+/, "org_") || `org_${Date.now()}`;
    fetch("http://127.0.0.1:8787/api/organizations", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ organization_id: organizationId, display_name: name }) }).then(async (response) => { const payload = await response.json(); if (!response.ok) throw new Error(payload.error || "创建组织失败"); return payload; }).then((created) => {
      const next = [...organizations, created]; setOrganizations(next); setCurrentOrganization(created.organization_id); localStorage.setItem("payroll-organizations", JSON.stringify(next)); localStorage.setItem("payroll-current-organization", created.organization_id); setNewOrganization(""); setOrganizationDialog(false); onNotify(`已添加组织，并创建独立配置库和业务库：${created.storage_path}`);
    }).catch((error) => onNotify(`添加失败：${error.message}`));
  };
  const removeOrganization = () => {
    if (organizations.length <= 1) { onNotify("至少需要保留一个组织"); return; }
    const current = organizations.find((item) => item.organization_id === currentOrganization);
    if (!current) return;
    fetch(`http://127.0.0.1:8787/api/organizations?organization_id=${encodeURIComponent(current.organization_id)}`, { method: "DELETE" }).then(async (response) => { const payload = await response.json(); if (!response.ok) throw new Error(payload.error || "删除组织失败"); return payload; }).then(() => {
      const remaining = organizations.filter((item) => item.organization_id !== currentOrganization); const nextId = remaining[0].organization_id; setOrganizations(remaining); setCurrentOrganization(nextId); localStorage.setItem("payroll-organizations", JSON.stringify(remaining)); localStorage.setItem("payroll-current-organization", nextId); onNotify(`已删除组织：${current.display_name}`);
    }).catch((error) => onNotify(`删除失败：${error.message}`));
  };
  const exportOrganizationBackup = async () => {
    try {
      const response = await localApiFetch("http://127.0.0.1:8787/api/organizations/backup", { method: "POST" });
      if (!response.ok) { const payload = await response.json(); throw new Error(payload.error || "组织备份失败"); }
      const blob = await response.blob(); const url = URL.createObjectURL(blob); const link = document.createElement("a"); link.href = url; link.download = "organization-backup.zip"; link.click(); URL.revokeObjectURL(url); onNotify("组织数据库备份已导出");
    } catch (error) { onNotify(`备份失败：${error.message}`); }
  };
  return (
    <>
      <header className="topbar">
        <div className="org-select">
        <span className="org-avatar">{(organizations.find((organization) => organization.organization_id === currentOrganization)?.display_name || "立天世纪").slice(0, 1)}</span>
        <div>
          <span>当前组织</span>
          <strong>{organizations.find((organization) => organization.organization_id === currentOrganization)?.display_name || "请选择组织"}</strong>
        </div>
        <ChevronDown size={16} />
        <select value={currentOrganization} onChange={(event) => switchOrganization(event.target.value)} aria-label="当前组织">
          {organizations.map((organization) => <option value={organization.organization_id} key={organization.organization_id}>{organization.display_name}</option>)}
        </select>
        </div>
        <div className="top-actions">
        <button className="button secondary" onClick={() => setOrganizationDialog(true)}><Plus size={16} />组织管理</button>
        <button
          className="button secondary"
          onClick={exportOrganizationBackup}
        >
          <Database size={16} />
          导出组织数据库
        </button>
        <button
          className="button primary"
          onClick={exportOrganizationBackup}
        >
          <Archive size={16} />
          导出完整组织
        </button>
        </div>
      </header>
      {organizationDialog && <div className="field-edit-backdrop"><section className="field-edit-dialog organization-dialog" role="dialog" aria-modal="true" aria-labelledby="organization-dialog-title"><div className="dialog-heading"><div><h2 id="organization-dialog-title">组织管理</h2><p>每个组织都有独立目录、SQLite 数据库、Schema、计算模型和历史记录。</p></div><button className="icon-button" aria-label="关闭组织管理" onClick={() => setOrganizationDialog(false)}><X size={17} /></button></div><label className="edit-field"><span>新增组织名称</span><input value={newOrganization} onChange={(event) => setNewOrganization(event.target.value)} placeholder="例如：星河科技（北京）有限公司" /></label><div className="organization-list">{organizations.map((organization) => <button type="button" key={organization.organization_id} className={organization.organization_id === currentOrganization ? "current" : ""} onClick={() => switchOrganization(organization.organization_id)}><span>{organization.display_name}<small className="organization-id">{organization.organization_id}</small></span>{organization.organization_id === currentOrganization && <small>当前组织</small>}</button>)}</div><div className="dialog-actions"><button className="button secondary" disabled={currentOrganization === "default_org"} title={currentOrganization === "default_org" ? "立天世纪是默认组织，不能删除" : "删除当前组织"} onClick={removeOrganization}><Trash2 size={15} />删除当前组织</button><button className="button primary" onClick={addOrganization}><Plus size={15} />添加组织</button></div></section></div>}
    </>
  );
}

function SettingsPage({ config, setConfig, onNotify }) {
  const [draft, setDraft] = useState(config);
  const [uploadLimitMb, setUploadLimitMb] = useState("256");
  const [keyEditing, setKeyEditing] = useState(false);
  const [savedKeyMask, setSavedKeyMask] = useState("");
  const [apiKeyConfigured, setApiKeyConfigured] = useState(false);
  const [testing, setTesting] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [savingUploadLimit, setSavingUploadLimit] = useState(false);
  const provider = aiProviders[draft.provider];
  const update = (changes) => setDraft((current) => ({ ...current, ...changes }));
  const selectProvider = (providerId) => {
    const next = aiProviders[providerId];
    update({ provider: providerId, baseUrl: next.baseUrl, model: next.defaultModel, models: next.models });
  };
  const callLocalApi = async (path, options = {}) => {
    const response = await fetch(`http://127.0.0.1:8787${path}`, options);
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "本地服务请求失败");
    return payload;
  };
  useEffect(() => {
    let active = true;
    callLocalApi("/api/settings/ai")
      .then((saved) => {
        if (!active) return;
        const next = {
          ...config,
          provider: saved.provider || config.provider,
          baseUrl: saved.base_url || config.baseUrl,
          model: saved.model || config.model,
          // 密钥只由本机服务保存；浏览器只保留接口配置，不缓存真实密钥或掩码。
          apiKey: "",
          models: config.models || [],
        };
        setSavedKeyMask(saved.api_key || "");
        setApiKeyConfigured(Boolean(saved.api_key_configured));
        setDraft(next);
        setConfig(next);
        localStorage.setItem("payroll-ai-config", JSON.stringify(next));
      })
      .catch(() => {});
    return () => { active = false; };
  }, []);
  useEffect(() => {
    let active = true;
    callLocalApi("/api/settings/runtime")
      .then((saved) => {
        if (active && Number.isInteger(saved.max_upload_mb)) setUploadLimitMb(String(saved.max_upload_mb));
      })
      .catch(() => {});
    return () => { active = false; };
  }, []);
  const save = () => {
    if (!draft.baseUrl.trim() || !draft.model.trim()) {
      onNotify("请填写 API 地址和模型名称");
      return;
    }
    const request = { provider: draft.provider, base_url: draft.baseUrl, model: draft.model, api_key: keyEditing ? draft.apiKey : "" };
    callLocalApi("/api/settings/ai", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(request) })
      .then((saved) => {
        const next = { ...draft, baseUrl: saved.base_url, model: saved.model, apiKey: "" };
        setSavedKeyMask(saved.api_key || "");
        setApiKeyConfigured(Boolean(saved.api_key_configured));
        setKeyEditing(false);
        localStorage.setItem("payroll-ai-config", JSON.stringify(next));
        setDraft(next);
        setConfig(next);
        onNotify("AI 配置已保存到本机服务");
      })
      .catch((error) => onNotify(`保存失败：${error.message}`));
  };
  const refreshModels = () => {
    setRefreshing(true);
    callLocalApi("/api/settings/ai/models/refresh", { method: "POST" })
      .then((result) => {
        update({ models: result.models, model: result.models.includes(draft.model) ? draft.model : result.models[0] || draft.model });
        onNotify(`已刷新 ${result.models.length} 个可用模型`);
      })
      .catch((error) => onNotify(`刷新失败：${error.message}`))
      .finally(() => setRefreshing(false));
  };
  const testConnection = () => {
    if (!draft.baseUrl.trim()) {
      onNotify("请先填写 API 地址");
      return;
    }
    setTesting(true);
    callLocalApi("/api/settings/ai/test", { method: "POST" })
      .then((result) => onNotify(`连接成功：发现 ${result.model_count} 个模型`))
      .catch((error) => onNotify(`连接失败：${error.message}`))
      .finally(() => setTesting(false));
  };
  const saveUploadLimit = () => {
    const value = Number(uploadLimitMb);
    if (!Number.isInteger(value) || value < 16 || value > 1048576) {
      onNotify("文件大小上限必须是 16 MB 到 1024 GB 之间的整数");
      return;
    }
    setSavingUploadLimit(true);
    callLocalApi("/api/settings/runtime", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ max_upload_mb: value }) })
      .then((saved) => {
        setUploadLimitMb(String(saved.max_upload_mb));
        onNotify(`真实数据文件上限已保存为 ${saved.max_upload_mb} MB`);
      })
      .catch((error) => onNotify(`保存失败：${error.message}`))
      .finally(() => setSavingUploadLimit(false));
  };
  return (
    <section className="page settings-page">
      <div className="page-heading">
        <div>
          <h1>设置</h1>
          <p>管理本地系统配置。AI 仅用于表头、字段和数据类型建议，不能直接导入或修改数据。</p>
        </div>
      </div>
      <div className="settings-layout">
        <section className="panel settings-panel">
          <div className="panel-header">
            <div>
              <h2>AI API 配置</h2>
              <p>选择服务商后可修改接口地址和模型；配置保存在本机服务，浏览器仅显示已保存密钥的掩码。</p>
            </div>
            <Bot size={22} />
          </div>
          <div className="settings-form">
            <label className="settings-field">
              <span>AI 服务商</span>
              <select value={draft.provider} onChange={(event) => selectProvider(event.target.value)}>
                {Object.entries(aiProviders).map(([id, item]) => <option key={id} value={id}>{item.label}</option>)}
              </select>
            </label>
            <label className="settings-field settings-wide">
              <span>API 地址</span>
              <input value={draft.baseUrl} onChange={(event) => update({ baseUrl: event.target.value })} placeholder="https://api.example.com/v1" />
              <small>建议使用 OpenAI 兼容的 Chat Completions API 地址。</small>
            </label>
            <label className="settings-field settings-wide">
              <span>API Key</span>
              <div className="key-input">
                <input type="text" value={keyEditing ? draft.apiKey : savedKeyMask} readOnly={!keyEditing} onChange={(event) => update({ apiKey: event.target.value })} placeholder={apiKeyConfigured ? "已保存 API Key" : "输入本机使用的 API Key"} autoComplete="off" />
                <button type="button" onClick={() => {
                  if (keyEditing) {
                    update({ apiKey: "" });
                    setKeyEditing(false);
                    return;
                  }
                  update({ apiKey: "" });
                  setKeyEditing(true);
                }}>{keyEditing ? "取消" : "修改"}</button>
              </div>
              <small>{apiKeyConfigured && !keyEditing ? `已保存：${savedKeyMask}。如需更换，请点击“修改”。` : "保存后由本地 Python 服务管理，浏览器不会向第三方直接发送 Key。"}</small>
            </label>
            <label className="settings-field">
              <span>模型名称</span>
              <input list="ai-models" value={draft.model} onChange={(event) => update({ model: event.target.value })} placeholder="例如 deepseek-chat" />
              <datalist id="ai-models">{(draft.models || []).map((model) => <option key={model} value={model} />)}</datalist>
            </label>
            <div className="settings-field settings-actions-field">
              <span>模型列表</span>
              <button className="button secondary compact" onClick={refreshModels} disabled={refreshing}>
                <RefreshCw size={15} className={refreshing ? "spin" : ""} />
                {refreshing ? "正在刷新" : "刷新模型列表"}
              </button>
            </div>
          </div>
          <div className="settings-footer">
            <button className="button secondary" onClick={testConnection} disabled={testing}>{testing ? "正在测试" : "连接测试"}</button>
            <button className="button primary" onClick={save}>保存配置</button>
          </div>
          <section className="settings-resource-section">
            <div className="settings-section-heading">
              <div>
                <h2>真实数据导入限制</h2>
                <p>真实业务文件由本地 Python 分块写入磁盘，不会按文件大小一次性读入内存。这里设置单次导入请求允许的最大文件大小。</p>
              </div>
              <Database size={22} />
            </div>
            <div className="settings-resource-form">
              <label className="settings-field">
                <span>单次文件大小上限（MB）</span>
                <input type="number" min="16" max="1048576" step="1" value={uploadLimitMb} onChange={(event) => setUploadLimitMb(event.target.value)} />
                <small>允许范围：16 MB–1024 GB。上限增大后仍受本机可用磁盘空间、导入耗时和数据库容量影响。</small>
              </label>
              <div className="settings-resource-actions">
                <button className="button primary" onClick={saveUploadLimit} disabled={savingUploadLimit}>{savingUploadLimit ? "正在保存" : "保存导入限制"}</button>
              </div>
            </div>
          </section>
        </section>
        <aside className="settings-aside">
          <section className="panel settings-guidance">
            <ShieldCheck size={22} />
            <h2>使用边界</h2>
            <p>系统仅发送经脱敏后的结构摘要，例如列名、类型统计和候选表头，不会把薪酬明细作为 AI 提示内容。</p>
            <p>AI 返回的字段建议会经过名称、类型和列来源校验，仍需用户确认表结构后才允许导入。</p>
          </section>
          <section className="panel settings-provider-card">
            <span>当前预设</span>
            <strong>{provider.label}</strong>
            <code>{draft.baseUrl || "请填写 API 地址"}</code>
            <small>默认模型：{provider.defaultModel || "由用户填写"}</small>
          </section>
        </aside>
      </div>
    </section>
  );
}

function Overview({ tables, logic, setLogic, logicValidated, onNotify }) {
  const [overviewMode, setOverviewMode] = useState("graph");
  const [question, setQuestion] = useState("");
  const [questionAnswer, setQuestionAnswer] = useState(null);
  const [questionHistory, setQuestionHistory] = useState([]);
  const [questionLoading, setQuestionLoading] = useState(false);
  const [outputLineage, setOutputLineage] = useState({ fields: [], rules: [], temporaryFields: [], inputFields: [] });
  const [currentStatuses, setCurrentStatuses] = useState([]);
  useEffect(() => {
    localApiFetch("http://127.0.0.1:8787/api/ai/data-question/history")
      .then((response) => response.ok ? response.json() : Promise.reject(new Error("历史答疑读取失败")))
      .then((payload) => setQuestionHistory(payload.items || []))
      .catch(() => setQuestionHistory([]));
  }, []);
  useEffect(() => {
    let active = true;
    const read = async (url, fallback) => {
      try {
        const response = await localApiFetch(url);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return await response.json();
      } catch {
        return fallback;
      }
    };
    Promise.all([
      read("http://127.0.0.1:8787/api/output/schema", { fields: [] }),
      read("http://127.0.0.1:8787/api/data/pages", { items: [] }),
      read("http://127.0.0.1:8787/api/output/field-rules", { items: [] }),
      read("http://127.0.0.1:8787/api/calculation/global-logic", { items: [] }),
      read("http://127.0.0.1:8787/api/calculation/temporary-fields", { items: [] }),
      read("http://127.0.0.1:8787/api/calculation-runs", { items: [] }),
    ]).then(([schema, pages, rules, globalLogic, temporaryFields, runs]) => {
      if (active) setCurrentStatuses(buildCurrentStatuses({ schema, pages: pages.items || [], rules: rules.items || [], globalLogic: globalLogic.items || [], temporaryFields: temporaryFields.items || [], runs: runs.items || [], logicValidated }));
    });
    return () => { active = false; };
  }, [logicValidated]);
  useEffect(() => {
    let active = true;
    const read = async (url, fallback) => {
      try {
        const response = await localApiFetch(url);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return await response.json();
      } catch {
        return fallback;
      }
    };
    Promise.all([
      read("http://127.0.0.1:8787/api/output/schema", { fields: [] }),
      read("http://127.0.0.1:8787/api/output/field-rules", { items: [] }),
      read("http://127.0.0.1:8787/api/calculation/temporary-fields", { items: [] }),
      read("http://127.0.0.1:8787/api/calculation/input-schema", { items: [] }),
    ]).then(([schema, rules, temporaryFields, inputFields]) => {
      if (active) setOutputLineage({ fields: Array.isArray(schema.fields) ? schema.fields : [], rules: Array.isArray(rules.items) ? rules.items : [], temporaryFields: Array.isArray(temporaryFields.items) ? temporaryFields.items : [], inputFields: Array.isArray(inputFields.items) ? inputFields.items : [] });
    });
    return () => { active = false; };
  }, []);
  const askDataQuestion = async () => {
    if (!question.trim()) { onNotify("请先输入要查询的数据问题"); return; }
    setQuestionLoading(true);
    try {
      const response = await localApiFetch("http://127.0.0.1:8787/api/ai/data-question", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ question, schema: dataTables.map((table) => ({ name: table.technical, display_name: table.name, fields: (tableMappings[table.technical] || []).map((field) => field.db) })) }) });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "数据答疑解析失败");
      setQuestionAnswer(payload);
      setQuestionHistory((items) => [payload, ...items.filter((item) => item.question_id !== payload.question_id)]);
      setOverviewMode("answer");
      onNotify("数据答疑解析完成");
    } catch (error) {
      onNotify(`数据答疑失败：${error.message}`);
    } finally {
      setQuestionLoading(false);
    }
  };
  return (
    <section className="page-frame">
      <PageHeading
        title="组织总览"
        description="组织数据、计算模型与历史核算均独立存储；真实业务数据只保存在当前组织的 SQLite 数据库中。"
      >
        <span className="published-pill">
          <span className="status-dot" />
          计算模型 v1.3 已发布
        </span>
      </PageHeading>
      <div className="overview-grid">
        <section className="panel graph-panel">
          <div className="panel-title">
            <div>
              <h2>数据与核算关系</h2>
              <p>
                {outputLineage.fields.length ? "已列出全部输出字段及其当前取值来源；计算逻辑会进一步展开引用的输入、输出和临时字段。" : "尚未确认输出模板，请先在“输出”页导入并确认字段。"}
              </p>
            </div>
            <div className="graph-panel-actions">
              <div className="view-switch" role="tablist" aria-label="总览内容切换"><button className={overviewMode === "graph" ? "active" : ""} onClick={() => setOverviewMode("graph")}>字段来源</button><button className={overviewMode === "answer" ? "active" : ""} onClick={() => setOverviewMode("answer")}>答疑解析</button></div>
            </div>
          </div>
          {overviewMode === "graph" ? <OutputFieldLineage fields={outputLineage.fields} rules={outputLineage.rules} temporaryFields={outputLineage.temporaryFields} inputFields={outputLineage.inputFields} /> : <div className="answer-analysis-panel"><div className="answer-analysis-heading"><div><h3>答疑解析</h3><p>根据当前组织的已确认数据结构、核算逻辑和结果表进行解释。</p></div><Bot size={22} /></div>{questionAnswer ? <><div className="answer-summary"><strong>{questionAnswer.answer}</strong></div><div className="answer-analysis-grid"><div><span>计算结果</span><p>{questionAnswer.result || "请以本地核算结果表为准"}</p><span>引用数据</span><p>{(questionAnswer.references || []).join("、") || "未识别到具体字段"}</p></div><div><span>计算步骤</span><ol>{(questionAnswer.steps || []).map((step) => <li key={step}>{step}</li>)}</ol></div></div></> : <div className="answer-empty">请在右侧“数据答疑”中输入问题，解析结果会显示在这里。</div>}</div>}
          <div className="graph-footer">
            <span><i className="legend output" />输出字段</span>
            <span><i className="legend data" />输入表字段</span>
            <span><i className="legend calculation" />计算逻辑 / 临时字段</span>
            <span className="output-lineage-count">共 {outputLineage.fields.length} 个输出字段</span>
          </div>
        </section>
        <aside className="overview-rail">
          <CurrentStatusPanel statuses={currentStatuses} />
          <section className="panel logic-panel">
            <div className="panel-title">
              <div>
                <h2>数据答疑</h2>
                <p>
                  用自然语言询问数据、计算结果和计算过程。
                </p>
              </div>
              <Bot size={19} className="muted" />
            </div>
            <textarea
              value={question}
              onChange={(event) => setQuestion(event.target.value)}
              aria-label="数据答疑问题"
              placeholder="例如：为什么张三本月的最终提成是这个金额？请列出引用字段和计算步骤。"
            />
            <div className="logic-footer">
              <span>
                <CircleCheck size={14} />
                只查询当前组织的 SQLite 数据和已确认计算逻辑
              </span>
              <button
                className="button primary compact"
                onClick={askDataQuestion}
                disabled={questionLoading}
              >
                <Bot size={15} />
                {questionLoading ? "正在解析" : "AI 解析答疑"}
              </button>
            </div>
            {questionHistory.length > 0 && <div className="data-question-history"><div className="data-question-history-heading"><strong>历史答疑</strong><span>{questionHistory.length} 条</span></div>{questionHistory.map((item) => <button type="button" className={`data-question-history-item ${questionAnswer?.question_id === item.question_id ? "active" : ""}`} key={item.question_id} onClick={() => { setQuestion(item.question); setQuestionAnswer(item); setOverviewMode("answer"); }}><strong>{item.question}</strong><small>{new Date(item.created_at).toLocaleString("zh-CN", { hour12: false })}</small></button>)}</div>}
          </section>
        </aside>
      </div>
    </section>
  );
}

function buildCurrentStatuses({ schema, pages, rules, globalLogic, temporaryFields, runs, logicValidated }) {
  const outputFields = Array.isArray(schema.fields) ? schema.fields : [];
  const allTablesParsed = pages.length > 0 && pages.every((page) => Array.isArray(page.fields) && page.fields.length > 0);
  const allTablesImported = allTablesParsed && pages.every((page) => page.latest_import?.status === "completed" && Number(page.latest_import?.record_count || 0) > 0);
  const activeGlobalLogicCount = globalLogic.filter((rule) => rule.status === "已解析" && rule.generatedCode).length;
  const activeTemporaryLogicCount = temporaryFields.filter((field) => field.status === "已解析" && field.generated_code).length;
  const activeLogicCount = activeGlobalLogicCount + activeTemporaryLogicCount;
  const allOutputRulesConfigured = outputFields.length > 0 && outputFields.every((field) => isOutputRuleCompleted(rules.find((rule) => rule.field_name === field.name)));
  const latestCompletedRun = runs.find((run) => run.status === "completed" && run.result_table);
  return [
    { title: "输出模板", detail: outputFields.length ? `已确认 ${outputFields.length} 个输出字段` : "尚未导入并确认输出模板", complete: outputFields.length > 0 },
    { title: "数据源表格模板", detail: allTablesParsed ? `已上传并完成 ${pages.length} 张表的结构解析` : pages.length ? `已解析 ${pages.filter((page) => Array.isArray(page.fields) && page.fields.length > 0).length} / ${pages.length} 张表` : "尚未上传数据源表格模板", complete: allTablesParsed },
    { title: "数据源表格内容", detail: allTablesImported ? `已导入 ${pages.length} 张表至本地数据库` : pages.length ? `已导入 ${pages.filter((page) => page.latest_import?.status === "completed" && Number(page.latest_import?.record_count || 0) > 0).length} / ${pages.length} 张表` : "等待先完成表格模板解析", complete: allTablesImported },
    { title: "核算逻辑配置", detail: activeLogicCount ? `${activeLogicCount} 条核算与临时逻辑已生效` : "尚无已生效的核算或临时逻辑", complete: activeLogicCount > 0 },
    { title: "输出字段配置", detail: outputFields.length ? (allOutputRulesConfigured ? `${outputFields.length} 个字段均已完成配置` : `已完成 ${outputFields.filter((field) => isOutputRuleCompleted(rules.find((rule) => rule.field_name === field.name))).length} / ${outputFields.length} 个字段`) : "等待先确认输出模板", complete: allOutputRulesConfigured },
    { title: "逻辑校验", detail: logicValidated ? "本次会话的逻辑校验已通过" : "尚未在本次会话执行逻辑校验", complete: logicValidated },
    { title: "核算结果与导出", detail: latestCompletedRun ? `已生成结果表 ${latestCompletedRun.result_table}，可导出` : "尚未生成可导出的核算结果", complete: Boolean(latestCompletedRun) },
  ];
}

function isOutputRuleCompleted(rule) {
  if (!rule) return false;
  if (rule.mode === "source") return Boolean(String(rule.source_ref || "").trim());
  if (rule.mode === "fixed") return String(rule.fixed_value ?? "").trim() !== "";
  return rule.mode === "formula" && rule.status === "已解析" && Boolean(String(rule.generated_code || "").trim());
}

function CurrentStatusPanel({ statuses }) {
  return <section className="panel current-status-panel">
    <div className="panel-title"><div><h2>当前状态</h2><p>汇总当前组织从模板导入到结果导出的关键进度。</p></div></div>
    <div className="current-status-list">
      {statuses.length ? statuses.map((item) => <div className={`current-status-item ${item.complete ? "complete" : "pending"}`} key={item.title}><span className="current-status-mark">{item.complete ? <Check size={14} /> : <span />}</span><div><strong>{item.title}</strong><small>{item.detail}</small></div><em>{item.complete ? "已完成" : "待完成"}</em></div>) : <div className="current-status-loading">正在读取当前组织状态…</div>}
    </div>
  </section>;
}

function OutputFieldLineage({ fields, rules, temporaryFields, inputFields }) {
  const rulesByField = new Map(rules.map((rule) => [rule.field_name, rule]));
  const temporaryByName = new Map(temporaryFields.map((field) => [field.name, field]));
  const inputFieldByReference = new Map(inputFields.map((field) => [`${field.table_name}.${field.field_name}`, field]));
  if (!fields.length) return <div className="output-lineage-empty">尚未读取已确认的输出字段。</div>;
  return <div className="output-lineage-list">
    {fields.map((field) => {
      const rule = rulesByField.get(field.name) || createDefaultOutputFieldRule(field.name);
      const sourceItems = describeOutputFieldSources(rule, temporaryByName, inputFieldByReference);
      return <article className="lineage-row" key={field.name}>
        <div className="lineage-output-node"><FileOutput size={15} /><div><strong>{field.display_name || field.name}</strong><code>{field.name} · {field.sqlite_type}</code></div><em>{rule.status || "待配置"}</em></div>
        <span className="lineage-link" aria-hidden="true" />
        <div className="lineage-source-stack">
          {sourceItems.map((item, index) => <div className={`lineage-source-node ${item.kind}`} key={`${field.name}-${item.kind}-${item.code}-${index}`}>
            <span className="lineage-source-icon">{item.kind === "fixed" ? "=" : item.kind === "logic" ? <Braces size={13} /> : item.kind === "temporary" ? <Workflow size={13} /> : <Database size={13} />}</span>
            <div><small>{item.label}</small><strong>{item.title}</strong>{item.code && <code>{item.code}</code>}{item.detail && <p>{item.detail}</p>}</div>
          </div>)}
        </div>
      </article>;
    })}
  </div>;
}

function describeOutputFieldSources(rule, temporaryByName, inputFieldByReference) {
  if (rule.mode === "fixed") return [{ kind: "fixed", label: "固定值", title: String(rule.fixed_value ?? "").trim() || "未填写固定值", code: "" }];
  if (rule.mode === "source") return [describeReferenceSource(rule.source_ref, temporaryByName, inputFieldByReference)];
  if (rule.mode === "formula") {
    const references = getRuleReferences(rule.description);
    return [
      { kind: "logic", label: "输出字段计算逻辑", title: rule.status === "已解析" ? "已确认计算逻辑" : "待确认计算逻辑", detail: rule.description || "尚未填写计算逻辑", code: "" },
      ...references.map((reference) => describeReferenceSource(reference, temporaryByName, inputFieldByReference)),
    ];
  }
  return [{ kind: "unconfigured", label: "取值来源", title: "待配置", code: "" }];
}

function getRuleReferences(description) {
  const matches = [...String(description || "").matchAll(/@([a-z][a-z0-9_]*)\.([a-z][a-z0-9_]*)/gi)];
  return [...new Set(matches.map((match) => `${match[1]}.${match[2]}`))];
}

function describeReferenceSource(reference, temporaryByName, inputFieldByReference) {
  const normalizedReference = String(reference || "").trim();
  if (!normalizedReference) return { kind: "unconfigured", label: "取值来源", title: "待选择数据来源", code: "" };
  const [tableName, fieldName] = normalizedReference.split(".");
  if (tableName === "temp") {
    const field = temporaryByName.get(fieldName);
    return { kind: "temporary", label: "临时字段", title: field?.display_name || fieldName, code: `temp.${fieldName}`, detail: field?.description || "该临时字段尚未填写计算逻辑" };
  }
  if (tableName === "output") return { kind: "output-reference", label: "其他输出字段", title: fieldName, code: `output.${fieldName}` };
  const configuredInputField = inputFieldByReference.get(normalizedReference);
  if (configuredInputField) return { kind: "source", label: "输入表字段", title: `${configuredInputField.table_label} · ${configuredInputField.field_label}`, code: normalizedReference };
  const table = dataTables.find((item) => item.technical === tableName);
  const field = (tableMappings[tableName] || []).find((item) => item.db === fieldName);
  return { kind: "source", label: "输入表字段", title: `${table?.name || tableName} · ${field?.excel || fieldName}`, code: normalizedReference };
}

function CalculationGraph({ scale = 1, tables = [], outputFields = [], validated = false }) {
  const graphTables = tables.length ? tables : dataTables;
  const hasOutput = outputFields.length > 0;
  return (
    <div className="graph-canvas">
      <div className="graph-zoom-layer" style={{ transform: `scale(${scale})` }}>
        {graphTables.map((table, index) => <GraphNode key={table.technical} className={`node-data-${index}`} kind="data" title={table.name} code={table.technical} style={{ left: "4%", top: `${Math.min(8 + index * 21, 82)}%` }} />)}
      {validated && <GraphNode
        className="node-summary"
        kind="calculation"
        title="销售额汇总"
        code="sales_summary"
        />}
      {validated && <GraphNode
        className="node-rate"
        kind="calculation"
        title="完成率"
        code="achievement_rate"
        />}
      {validated && <GraphNode
        className="node-base"
        kind="calculation"
        title="基础提成"
        code="base_commission"
        />}
      {validated && <GraphNode
        className="node-factor"
        kind="calculation"
        title="回款系数"
        code="collection_factor"
        />}
      {validated && <GraphNode
        className="node-final"
        kind="calculation"
        title="最终提成"
        code="final_commission"
        />}
      {(validated || hasOutput) && <GraphNode
        className="node-output"
        kind="output"
        title="本地核算结果"
        code="local_calculation_result"
        />}
        {validated && <svg
        className="graph-lines"
        viewBox="0 0 900 650"
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        <defs>
          <marker
            id="arrow"
            markerWidth="8"
            markerHeight="8"
            refX="6"
            refY="4"
            orient="auto"
          >
            <path d="M0,0 L8,4 L0,8z" fill="#77858d" />
          </marker>
        </defs>
        <path d="M220 105 H315 V230 H400" />
        <path d="M220 230 H400" />
        <path d="M515 230 H570" />
        <path d="M650 270 V360" />
        <path d="M515 230 V420 H570" />
        <path d="M220 400 H400" />
        <path d="M515 400 H570" />
        <path d="M220 555 H615 V510" />
        <path d="M650 400 V510" />
        <path d="M715 510 H770" />
        </svg>}
      </div>
    </div>
  );
}
function GraphNode({ kind, title, code, className, style }) {
  const Icon = kind === "data" ? Table2 : kind === "output" ? Boxes : Braces;
  return (
    <div className={`graph-node ${kind} ${className}`} style={style}>
      <Icon size={18} />
      <div>
        <strong>{title}</strong>
        <span>{code}</span>
      </div>
    </div>
  );
}

function TableIdentity({ table, onRename, existingTableNames = [] }) {
  const [editing, setEditing] = useState(false);
  const [customName, setCustomName] = useState(table.name);
  const [databaseName, setDatabaseName] = useState(table.technical);
  const [validationError, setValidationError] = useState("");
  const validateAndSave = () => {
    const trimmedName = customName.trim();
    if (!trimmedName) return setValidationError("用户自定义表名称不能为空。");
    if (!databaseName) return setValidationError("数据库表名不能为空。");
    if (!/^[a-z][a-z0-9_]{0,62}$/.test(databaseName)) {
      return setValidationError("数据库表名必须以英文字母开头，只能包含英文字母、数字和下划线，长度不超过 63 个字符。");
    }
    if (databaseName !== table.technical && existingTableNames.includes(databaseName)) {
      return setValidationError(`数据库表名“${databaseName}”已存在，请换一个名称。`);
    }
    onRename?.(trimmedName, databaseName);
    setValidationError("");
    setEditing(false);
  };
  return (
    <div className="table-identity">
      <div className="table-identity-heading">
        <div>
          <h2>{customName}</h2>
          <div className="table-identity-meta">
            <span>Excel 文件：{table.excelFile || "未记录文件名"}</span>
            <code>数据库表：{table.technical}</code>
          </div>
        </div>
        <button className="button secondary compact" onClick={() => { setValidationError(""); setEditing(true); }}>
          修改表名称
        </button>
      </div>
      {editing && (
        <div className="field-edit-backdrop">
          <section className="field-edit-dialog" role="dialog" aria-modal="true" aria-labelledby="edit-table-name">
            <div className="dialog-heading">
              <div>
                <h2 id="edit-table-name">修改表名称</h2>
                <p>用户自定义名称用于业务识别；数据库表名会同步重命名 SQLite 物理表。</p>
              </div>
              <button className="icon-button" aria-label="关闭表名称修改对话框" onClick={() => setEditing(false)}><X size={17} /></button>
            </div>
            <label className="edit-field">
              <span>用户自定义表名称</span>
              <input value={customName} onChange={(event) => setCustomName(event.target.value)} />
            </label>
            <label className="edit-field">
              <span>数据库表名</span>
              <input value={databaseName} onChange={(event) => { setDatabaseName(event.target.value); setValidationError(""); }} />
              <small className="field-help">仅支持英文字母、数字和下划线，且建议以字母开头。</small>
            </label>
            {validationError && <div className="validation-error" role="alert">{validationError}</div>}
            <div className="edit-preview">
              <span>只读信息</span>
              <strong>Excel 文件：{table.excelFile || "未记录文件名"}</strong>
              <small>原数据库表：{table.technical}</small>
            </div>
            <div className="dialog-actions">
              <button className="button secondary" onClick={() => setEditing(false)}>取消</button>
              <button className="button primary" onClick={validateAndSave}>保存修改</button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}

function SchemaConfirmationAction({ onNotify, onConfirmed, initialConfirmed = false, initialConfirmedAt = "" }) {
  const [confirmedAt, setConfirmedAt] = useState(initialConfirmed ? (initialConfirmedAt || "已确认") : "");
  const [recordOpen, setRecordOpen] = useState(false);
  const confirmSchema = () => {
    if (onConfirmed?.() === false) return;
    const timestamp = new Date().toLocaleString("zh-CN", { hour12: false });
    setConfirmedAt(timestamp);
    onNotify("表结构已确认");
  };
  if (!confirmedAt) {
    return <button className="button primary" onClick={confirmSchema}><Check size={15} />确认表结构</button>;
  }
  return <>
    <button className="button secondary" onClick={() => setRecordOpen(true)}><FileCheck2 size={15} />查看确认记录</button>
    {recordOpen && <div className="field-edit-backdrop"><section className="field-edit-dialog confirmation-dialog" role="dialog" aria-modal="true" aria-labelledby="confirmation-record-title"><div className="dialog-heading"><div><h2 id="confirmation-record-title">表结构确认记录</h2><p>当前字段映射方案已确认，后续导入将按照已勾选列执行。</p></div><button className="icon-button" aria-label="关闭确认记录" onClick={() => setRecordOpen(false)}><X size={17} /></button></div><div className="confirmation-record"><span>确认时间</span><strong>{confirmedAt}</strong></div><div className="dialog-actions"><button className="button primary" onClick={() => setRecordOpen(false)}>关闭</button></div></section></div>}
  </>;
}

function ImportDataAction({ table, schemaConfirmed, onImport }) {
  const [recordOpen, setRecordOpen] = useState(false);
  const record = table.lastImport;
  if (table.importStatus !== "已导入") {
    return <button className="button primary" disabled={!schemaConfirmed} onClick={onImport}><FileUp size={15} />导入真实业务数据</button>;
  }
  return <>
    <button className="button secondary" onClick={() => setRecordOpen(true)}><ScrollText size={15} />查看导入记录</button>
    {recordOpen && <ModalPortal>
      <div className="field-edit-backdrop">
        <section className="field-edit-dialog confirmation-dialog" role="dialog" aria-modal="true" aria-labelledby="import-record-title">
          <div className="dialog-heading">
            <div><h2 id="import-record-title">真实业务数据导入记录</h2><p>本记录只展示文件、批次和数量摘要，不展示薪酬或业务明细。</p></div>
            <button className="icon-button" aria-label="关闭导入记录" onClick={() => setRecordOpen(false)}><X size={17} /></button>
          </div>
          <div className="confirmation-record import-record">
            <div><span>导入状态</span><strong>已完成</strong></div>
            <div><span>导入文件</span><strong>{record?.fileName || table.excelFile}</strong></div>
            <div><span>工作表</span><strong>{record?.sheetName || "未记录"}</strong></div>
            <div><span>导入时间</span><strong>{record?.importedAt || table.updated}</strong></div>
            <div><span>写入记录</span><strong>{record?.recordCount || table.records}</strong></div>
            <div><span>导入批次</span><strong>{record?.batchId || "未记录"}</strong></div>
            <div><span>结构校验</span><strong>完全一致</strong></div>
          </div>
          <div className="dialog-actions">
            <button className="button secondary" onClick={() => { setRecordOpen(false); onImport(); }}><FileUp size={15} />重新导入数据</button>
            <button className="button primary" onClick={() => setRecordOpen(false)}>关闭</button>
          </div>
        </section>
      </div>
    </ModalPortal>}
  </>;
}

const inferUploadedColumnType = (columnName) => {
  const name = String(columnName || "");
  if (/日期|时间|date|time/i.test(name)) return "TEXT";
  if (/金额|工资|薪资|基数|比例|天数|小时|数量|金额|率|amount|salary|days|hours|rate/i.test(name)) return "NUMERIC";
  return "TEXT";
};

const dataTableDisplayName = (fileName, sheetName, sourceCount) => {
  const base = String(fileName || "数据表").replace(/\.[^.]+$/, "").trim() || "数据表";
  return sourceCount > 1 && sheetName ? `${base} · ${sheetName}` : base;
};

function toClientTable(page) {
  const fieldMappings = (page.fields || []).map((field) => ({
    excel: field.excel_name || field.display_name,
    db: field.technical_name,
    excelType: field.sqlite_type === "NUMERIC" || field.sqlite_type === "REAL" ? "数值" : "文本",
    dbType: field.sqlite_type,
    transform: "无需转换",
    required: Boolean(field.required),
  }));
  const latest = page.latest_import;
  return {
    name: page.display_name,
    technical: page.technical_name,
    excelFile: "已确认数据源模板",
    selectedFields: fieldMappings.length,
    fields: fieldMappings.length,
    fieldMappings,
    type: page.data_role || "输入子表",
    schemaStatus: "已确认",
    importStatus: latest?.status === "completed" ? "已导入" : "待导入",
    lastImport: latest ? { fileName: latest.source_file, importedAt: latest.created_at, recordCount: `${latest.record_count} 条`, batchId: latest.batch_id, sheetName: page.selected_sheet } : null,
    records: latest?.status === "completed" ? `${latest.record_count} 条` : "0 条",
    updated: page.created_at || "已确认",
    period: "",
    primaryKey: page.primary_keys?.[0] || "",
    selectedSheet: page.selected_sheet || "",
  };
}

function DataImportDialog({ table, onClose, onNotify, onImported, onLog }) {
  const [file, setFile] = useState(null);
  const [sheets, setSheets] = useState([]);
  const [sheet, setSheet] = useState("");
  const [validation, setValidation] = useState(null);
  const [importing, setImporting] = useState(false);
  const inputRef = useRef(null);
  const inspectWithPython = async (nextFile, selectedSheet = "") => {
    const formData = new FormData();
    formData.append("page_name", table.technical);
    if (selectedSheet) formData.append("sheet_name", selectedSheet);
    formData.append("file", nextFile, nextFile.name);
    const response = await localApiFetch("http://127.0.0.1:8787/api/data/inspect", { method: "POST", body: formData });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "本地 Python 表结构检查失败");
    const checked = payload.validation;
    if (checked) setValidation({ ok: checked.ok, headerRow: checked.header_row, missing: checked.missing_columns || [], extra: checked.unexpected_columns || [] });
    return payload;
  };
  const inspectFile = async (event) => {
    const nextFile = event.target.files?.[0];
    if (!nextFile) return;
    setFile(nextFile);
    setValidation(null);
    try {
      const inspected = await inspectWithPython(nextFile);
      const names = inspected.sheet_names || [];
      setSheets(names);
      setSheet(inspected.selected_sheet || "");
      if (!names.length) onNotify("未读取到工作表，请确认文件未损坏且不是加密文件");
    } catch (error) {
      setSheets([]);
      setSheet("");
      onLog?.("error", "正式数据文件解析失败", `文件：${nextFile.name}；原因：${error.message}`);
      onNotify(`无法读取 Excel 工作表：${error.message}`);
    }
  };
  const validateSheet = async () => {
    if (!file || !sheet) return;
    setImporting(true);
    try { await inspectWithPython(file, sheet); }
    catch (error) { setValidation(null); onLog?.("error", "表结构校验失败", `文件：${file.name}；原因：${error.message}`); onNotify(`表结构校验失败：${error.message}`); }
    finally { setImporting(false); }
  };
  const startImport = async () => {
    if (!file || !validation?.ok) return;
    setImporting(true);
    onLog?.("info", "开始导入正式数据", `数据表：${table.name}；文件：${file.name}；Sheet：${sheet}`);
    try {
      const formData = new FormData();
      formData.append("page_name", table.technical);
      formData.append("sheet_name", sheet);
      formData.append("period", table.period || "2026-08");
      formData.append("replace_current", table.importStatus === "已导入" ? "true" : "false");
      formData.append("file", file, file.name);
      const response = await localApiFetch("http://127.0.0.1:8787/api/data/import", { method: "POST", body: formData });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "真实业务数据导入失败");
      await onImported?.({ fileName: payload.source_file, sheetName: payload.sheet_name, importedAt: new Date().toLocaleString("zh-CN", { hour12: false }), recordCount: `${payload.record_count} 条`, batchId: payload.batch_id });
      onLog?.("success", "真实业务数据导入完成", `数据表：${table.name}；已写入 ${payload.record_count} 条；批次：${payload.batch_id}`);
      onClose(); onNotify(`真实业务数据导入完成，共写入 ${payload.record_count} 条`);
    } catch (error) {
      onLog?.("error", "真实业务数据导入失败", `数据表：${table.name}；原因：${error.message}`);
      onNotify(`导入失败：${error.message}`);
    } finally { setImporting(false); }
  };
  const validationMessage = validation?.ok
    ? `表结构校验通过：第 ${validation.headerRow} 行为表头，字段与已确认模板完全一致。`
    : validation
      ? `表结构校验失败：${validation.missing.length ? `缺少字段 ${validation.missing.join("、")}` : ""}${validation.missing.length && validation.extra.length ? "；" : ""}${validation.extra.length ? `存在未确认字段 ${validation.extra.join("、")}` : ""}。已停止导入。`
      : "";
  return <ModalPortal>
    <div className="field-edit-backdrop">
      <section className="field-edit-dialog import-data-dialog" role="dialog" aria-modal="true" aria-labelledby="import-data-title">
        <div className="dialog-heading">
          <div><h2 id="import-data-title">导入真实业务数据</h2><p>选择实际业务文件和工作表。文件必须与“数据”页已确认的字段结构完全一致，校验通过后才会由本地 Python 写入 SQLite。</p></div>
          <button className="icon-button" aria-label="关闭真实业务数据导入对话框" onClick={onClose}><X size={17} /></button>
        </div>
        <div className="dialog-note privacy-note"><ShieldCheck size={16} /><span>本步骤不调用 AI，也不会把文件内容或业务数据发送给大模型。</span></div>
        <button className="dropzone import-dropzone" onClick={() => inputRef.current?.click()}><Upload size={23} /><strong>{file ? file.name : "选择真实业务数据文件"}</strong><span>{file ? `${sheets.length} 个 Sheet` : "校验失败时不会写入或覆盖当前有效数据"}</span></button>
        <input ref={inputRef} className="hidden-file" type="file" accept=".xlsx,.xlsm,.csv" onChange={inspectFile} />
        {file && sheets.length > 1 && <label className="edit-field"><span>请选择要导入的 Sheet</span><select value={sheet} onChange={(event) => { setSheet(event.target.value); setValidation(null); }}>{!sheet && <option value="">请选择 Sheet</option>}{sheets.map((name) => <option key={name} value={name}>{name}</option>)}</select></label>}
        {file && sheets.length === 1 && <div className="selected-sheet">已选择 Sheet：{sheets[0]}</div>}
        {validation && <div className={validation.ok ? "validation-success" : "validation-error"}>{validationMessage}</div>}
        <div className="dialog-actions">
          <button className="button secondary" onClick={onClose}>取消</button>
          <button className="button secondary" disabled={!file || !sheet || importing} onClick={validateSheet}>校验表结构</button>
          <button className="button primary" disabled={!validation?.ok || importing} onClick={startImport}>{importing ? "正在导入" : "开始导入"}</button>
        </div>
      </section>
    </div>
  </ModalPortal>;
}

function DataPage({ tables, setTables, selected, setSelected, onNotify }) {
  const [requiredItems, setRequiredItems] = useState(() => payrollRequiredItems.map((item) => ({ ...item, status: "待导入", sourceFile: "", sheetName: "", mapping: {} })));
  const [outputTemplateFields, setOutputTemplateFields] = useState([]);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [uploadTargetItemId, setUploadTargetItemId] = useState("");
  const [uploadSources, setUploadSources] = useState([]);
  const [uploadFile, setUploadFile] = useState(null);
  const [uploadSheet, setUploadSheet] = useState("");
  const [uploadSheets, setUploadSheets] = useState([]);
  const [uploadWorkbook, setUploadWorkbook] = useState(null);
  const [uploadColumns, setUploadColumns] = useState([]);
  const [mappingDraft, setMappingDraft] = useState({});
  const [usedFields, setUsedFields] = useState({ employee_id: true, period: true, sales_amount: true, source_file: true, _sys_batch_id: true });
  const [selectedFieldCounts, setSelectedFieldCounts] = useState(() => Object.fromEntries(dataTables.map((table) => [table.technical, table.selectedFields])));
  const [primaryKeys, setPrimaryKeys] = useState(() => Object.fromEntries(dataTables.map((table) => [table.technical, "employee_id"])));
  const [dataLogs, setDataLogs] = useState([]);
  const fileInput = useRef(null);
  const sourceTables = useMemo(() => tables, [tables]);
  const current = useMemo(
    () => sourceTables.find((item) => item.name === selected) || sourceTables[0],
    [selected, sourceTables],
  );
  const schemaConfirmed = current?.schemaStatus === "已确认";
  const currentSchemaStatus = current?.schemaStatus || "待确认";
  const confirmedCount = sourceTables.filter((item) => item.schemaStatus === "已确认").length;
  const outputFieldKeys = useMemo(() => new Set(outputTemplateFields.map((field) => field.source ? `${field.source}.${field.name}` : field.name)), [outputTemplateFields]);
  const outputAwareItems = useMemo(() => requiredItems.map((item) => ({ ...item, fields: item.fields.map((field) => ({ ...field, neededByOutput: outputFieldKeys.has(`employee_master.${field.key}`) || outputFieldKeys.has(`${item.id}.${field.key}`) })) })), [requiredItems, outputFieldKeys]);
  const activeUploadItem = outputAwareItems.find((item) => item.id === uploadTargetItemId);
  const uploadColumnOptions = uploadSources.flatMap((source) => source.columns.map((column) => ({ ...column, sourceId: source.id, ref: `${source.id}::${column.name}`, display: `${source.fileName}.${column.name}`, matchLabel: `${source.fileName}.${column.name}` })));
  const appendDataLog = (level, message, detail = "") => {
    setDataLogs((logs) => [{
      id: `runtime-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      level,
      message,
      detail,
      createdAt: new Date().toLocaleString("zh-CN", { hour12: false }),
      source: "本次操作",
    }, ...logs].slice(0, 80));
  };
  const savePrimaryKey = async () => {
    const pageName = current?.technical;
    const primaryKey = primaryKeys[pageName] || "";
    if (!pageName || !primaryKey) {
      onNotify("请先选择一个主键字段");
      return;
    }
    try {
      const response = await localApiFetch("http://127.0.0.1:8787/api/data/pages/primary-key", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ page_name: pageName, primary_key: primaryKey }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "主键保存失败");
      setTables((items) => items.map((item) => item.technical === pageName ? { ...item, primaryKey } : item));
      appendDataLog("success", "主键字段已保存", `数据表：${current.name}；主键：${primaryKey}`);
      onNotify(`主键字段已保存：${primaryKey}`);
    } catch (error) {
      appendDataLog("error", "主键字段保存失败", error.message);
      onNotify(`主键保存失败：${error.message}`);
    }
  };
  const applyDataPages = (restored) => {
    setTables(restored);
    setSelectedFieldCounts(Object.fromEntries(restored.map((item) => [item.technical, item.fieldMappings.length])));
    setPrimaryKeys(Object.fromEntries(restored.map((item) => [item.technical, item.primaryKey || item.fieldMappings[0]?.db || ""])));
    setSelected((currentSelected) => restored.some((item) => item.name === currentSelected) ? currentSelected : (restored[0]?.name || ""));
  };

  const fetchDataPages = async () => {
    const response = await localApiFetch("http://127.0.0.1:8787/api/data/pages");
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || "数据表列表读取失败");
    return (payload.items || []).map(toClientTable);
  };

  useEffect(() => {
    let active = true;
    const eventMeta = {
      schema_confirmed: { level: "success", message: "数据表结构已确认" },
      data_page_created: { level: "success", message: "数据表结构已创建" },
    };
    localApiFetch("http://127.0.0.1:8787/api/audit")
      .then((response) => response.ok ? response.json() : Promise.reject(new Error("操作日志读取失败")))
      .then((payload) => {
        if (!active) return;
        const history = (payload.items || []).flatMap((item) => {
          const meta = eventMeta[item.event_type];
          if (!meta) return [];
          let detailPayload = {};
          try { detailPayload = JSON.parse(item.payload_json || "{}"); } catch { detailPayload = {}; }
          const details = [
            detailPayload.table_name || detailPayload.project_id || item.object_id,
            detailPayload.source_file ? `文件：${detailPayload.source_file}` : "",
            detailPayload.sheet_name ? `Sheet：${detailPayload.sheet_name}` : "",
            detailPayload.record_count !== undefined ? `记录：${detailPayload.record_count} 条` : "",
            detailPayload.error ? `原因：${detailPayload.error}` : "",
          ].filter(Boolean).join("；");
          return [{ id: `audit-${item.audit_id}`, ...meta, detail: details, createdAt: item.created_at || "历史记录", source: "已保存" }];
        });
        setDataLogs(history.slice(0, 80));
      })
      .catch((error) => {
        if (active) appendDataLog("error", "无法读取已保存的操作日志", error.message);
      });
    return () => { active = false; };
  }, []);
  useEffect(() => {
    let active = true;
    fetchDataPages()
      .then((restored) => {
        if (!active) return;
        applyDataPages(restored);
      })
      .catch((error) => appendDataLog("error", "无法读取当前组织数据表", error.message));
    return () => { active = false; };
  }, []);
  useEffect(() => {
    localApiFetch("http://127.0.0.1:8787/api/output/schema").then((response) => response.ok ? response.json() : Promise.reject(new Error("输出模板读取失败"))).then((payload) => setOutputTemplateFields(payload.fields || [])).catch(() => setOutputTemplateFields([]));
  }, []);
  useEffect(() => {
    localApiFetch("http://127.0.0.1:8787/api/payroll/foundation/configs")
      .then((response) => response.ok ? response.json() : Promise.reject(new Error("基础资料配置读取失败")))
      .then((payload) => setRequiredItems((items) => items.map((item) => {
        const projectId = item.id === "roster" ? "employee_master" : item.id;
        const saved = payload.items.find((config) => config.project_id === projectId);
        return saved ? { ...item, status: "已确认", mapping: saved.mapping || {}, sourceFiles: (saved.sources || []).map((source) => ({ fileName: source.file_name, sheetName: source.sheet_name, headerRow: source.header_row, columns: source.columns || [] })), mappedAt: saved.updated_at } : item;
      })))
      .catch(() => {});
  }, []);
  const openUpload = (item = null) => {
    const targetItem = item?.id ? item : null;
    setUploadTargetItemId(targetItem?.id || "");
    setMappingDraft(targetItem?.mapping || {});
    setUploadSources([]);
    setUploadFile(null);
    setUploadSheet("");
    setUploadSheets([]);
    setUploadWorkbook(null);
    setUploadColumns([]);
    setUploadOpen(true);
    appendDataLog("info", "已打开模板上传窗口", targetItem ? `准备配置：${targetItem.title}` : "请选择 Excel 或 CSV 模板后解析其 Sheet 和表头");
  };
  const autoMapRequiredFields = (sources, item) => {
    if (!item) return {};
    return Object.fromEntries(item.fields.map((field) => {
      const match = sources.flatMap((source) => source.columns.map((column) => ({ source, column }))).find(({ column }) => suggestFieldName(column.name) === field.key || column.name === field.label || column.name === field.key);
      return [field.key, match ? `${match.source.id}::${match.column.name}` : ""];
    }));
  };
  const updateFieldUse = (fieldName, nextUsed) => {
    const fieldKey = `${current.technical}.${fieldName}`;
    setUsedFields((previous) => {
      if ((previous[fieldKey] ?? previous[fieldName] ?? true) === nextUsed) return previous;
      setSelectedFieldCounts((counts) => ({
        ...counts,
        [current.technical]: Math.max(0, (counts[current.technical] || 0) + (nextUsed ? 1 : -1)),
      }));
      return { ...previous, [fieldKey]: nextUsed };
    });
  };
  const readTemplateSheet = (workbook, sheetName) => {
    const rows = sheetName
      ? XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, defval: "" })
      : [];
    const headers = Array.isArray(rows[0])
      ? rows[0].map((value) => String(value).trim()).filter(Boolean)
      : [];
    setUploadSheet(sheetName || "未找到工作表");
    setUploadColumns(headers.map((name, index) => ({ index: index + 1, name, field: suggestFieldName(name) })));
  };
  const readHeadersFromWorkbook = (workbook, sheetName) => {
    if (!sheetName || !workbook?.Sheets?.[sheetName]) return [];
    const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, defval: "" });
    const candidates = rows.slice(0, 8).map((row, rowIndex) => {
      const values = Array.isArray(row) ? row.map((value) => String(value ?? "").trim()) : [];
      const nonEmpty = values.filter(Boolean);
      const aliasMatches = nonEmpty.reduce((count, value) => count + (suggestFieldName(value) ? 1 : 0), 0);
      return { rowIndex, values, nonEmpty, score: aliasMatches * 10 + Math.min(nonEmpty.length, 12) };
    }).filter((candidate) => candidate.nonEmpty.length > 0);
    if (!candidates.length) return [];
    const best = candidates.reduce((winner, candidate) => candidate.score > winner.score ? candidate : winner, candidates[0]);
    const columns = best.values.filter(Boolean).map((name, index) => ({ index: index + 1, name, field: suggestFieldName(name) }));
    columns.headerRow = best.rowIndex + 1;
    return columns;
  };
  const handleFiles = async (event) => {
    const files = Array.from(event.target.files || []);
    event.target.value = "";
    if (!files.length) return;
    const loadedSources = await Promise.all(files.map(async (file, index) => {
      try {
        const workbook = XLSX.read(await file.arrayBuffer(), { type: "array" });
        const sheets = workbook.SheetNames || [];
        const sheetName = sheets.length === 1 ? sheets[0] : "";
        const columns = readHeadersFromWorkbook(workbook, sheetName);
        return { id: `${Date.now()}-${index}-${file.name}`, file, fileName: file.name, size: file.size, workbook, sheets, sheetName, columns, headerRow: columns.headerRow || null };
      } catch {
        return { id: `${Date.now()}-${index}-${file.name}`, fileName: file.name, size: file.size, workbook: null, sheets: [], sheetName: "", columns: [], error: "无法读取文件结构" };
      }
    }));
    setUploadSources((currentSources) => {
      const nextSources = [...currentSources, ...loadedSources];
      setMappingDraft((mapping) => activeUploadItem ? { ...autoMapRequiredFields(nextSources, activeUploadItem), ...mapping } : mapping);
      return nextSources;
    });
    loadedSources.forEach((source) => {
      if (source.error) {
        appendDataLog("error", "模板文件解析失败", `文件：${source.fileName}；原因：${source.error}`);
      } else if (source.sheetName && source.columns.length) {
        appendDataLog("success", "模板文件解析完成", `文件：${source.fileName}；Sheet：${source.sheetName}；第 ${source.headerRow || 1} 行识别为表头，共 ${source.columns.length} 列`);
      } else {
        appendDataLog("info", "模板文件已读取，等待选择 Sheet", `文件：${source.fileName}；发现 ${source.sheets.length} 个 Sheet`);
      }
    });
  };
  const updateUploadSourceSheet = (sourceId, sheetName) => {
    setUploadSources((sources) => {
      const nextSources = sources.map((source) => {
        if (source.id !== sourceId) return source;
        const columns = readHeadersFromWorkbook(source.workbook, sheetName);
        return { ...source, sheetName, columns, headerRow: columns.headerRow || null };
      });
      setMappingDraft((mapping) => activeUploadItem ? { ...autoMapRequiredFields(nextSources, activeUploadItem), ...mapping } : mapping);
      return nextSources;
    });
    const source = uploadSources.find((item) => item.id === sourceId);
    const columns = source ? readHeadersFromWorkbook(source.workbook, sheetName) : [];
    appendDataLog(columns.length ? "success" : "error", columns.length ? "Sheet 与表头识别完成" : "未能识别 Sheet 表头", source ? `文件：${source.fileName}；Sheet：${sheetName}；${columns.length ? `第 ${columns.headerRow || 1} 行为表头，共 ${columns.length} 列` : "请检查 Sheet 内容"}` : "");
  };
  const removeUploadSource = (sourceId) => {
    setUploadSources((sources) => sources.filter((source) => source.id !== sourceId));
    setMappingDraft((mapping) => Object.fromEntries(Object.entries(mapping).filter(([, ref]) => !String(ref).startsWith(`${sourceId}::`))));
  };
  const confirmRequiredItemMapping = async () => {
    if (!activeUploadItem || !uploadSources.length || uploadSources.some((source) => !source.sheetName || !source.columns.length)) {
      appendDataLog("error", "字段映射未提交", "仍有文件未选择 Sheet 或未识别到表头");
      onNotify("请为每个 Excel 文件选择 Sheet，并确认可读取到表头");
      return;
    }
    const missing = activeUploadItem.fields.filter((field) => field.required && !mappingDraft[field.key]);
    if (missing.length) {
      appendDataLog("error", "字段映射未提交", `“${activeUploadItem.title}”缺少必填字段：${missing.map((field) => field.label).join("、")}`);
      onNotify(`“${activeUploadItem.title}”仍缺少映射：${missing.map((field) => field.label).join("、")}`);
      return;
    }
    try {
      const response = await localApiFetch("http://127.0.0.1:8787/api/payroll/foundation/schema", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          project_id: activeUploadItem.id === "roster" ? "employee_master" : activeUploadItem.id,
          display_name: activeUploadItem.title,
          fields: activeUploadItem.fields,
          mapping: mappingDraft,
          mapping_display: Object.fromEntries(Object.entries(mappingDraft).map(([fieldKey, ref]) => [fieldKey, uploadColumnOptions.find((column) => column.ref === ref)?.matchLabel || ref])),
          sources: uploadSources.map((source) => ({ id: source.id, file_name: source.fileName, sheet_name: source.sheetName, header_row: source.headerRow || 1, columns: source.columns.map((column) => column.name) })),
        }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "表结构与字段映射保存失败");
      setRequiredItems((items) => items.map((item) => item.id === activeUploadItem.id ? { ...item, status: "已确认", tableName: payload.project_id, recordCount: 0, sourceFiles: uploadSources.map((source) => ({ fileName: source.fileName, sheetName: source.sheetName, headerRow: source.headerRow, columns: source.columns.map((column) => column.name) })), mapping: mappingDraft, mappedAt: new Date().toLocaleString("zh-CN", { hour12: false }) } : item));
      setUploadOpen(false);
      appendDataLog("success", "表结构与字段映射已确认", `项目：${activeUploadItem.title}；只保存结构摘要，未读取或写入业务行`);
      onNotify(`“${activeUploadItem.title}”的表结构与字段映射已保存，真实数据请到“数据导入”页处理`);
    } catch (error) {
      appendDataLog("error", "表结构与字段映射保存失败", `项目：${activeUploadItem.title}；原因：${error.message}`);
      onNotify(`保存失败：${error.message}`);
    }
  };
  const createTablesFromTemplate = async () => {
    const invalidSources = uploadSources.filter((source) => !source.sheetName || !source.columns.length);
    if (invalidSources.length) {
      appendDataLog("error", "数据表未创建", `以下文件尚未选择 Sheet 或识别表头：${invalidSources.map((source) => source.fileName).join("、")}`);
      onNotify("请先为每个文件选择 Sheet，并确认已识别表头");
      return;
    }
    try {
      const created = [];
      for (const [sourceIndex, source] of uploadSources.entries()) {
        const usedNames = new Set();
        const fields = source.columns.map((column, columnIndex) => ({
          technical_name: makeOutputFieldName(column.name, columnIndex, usedNames),
          display_name: column.name,
          sqlite_type: inferUploadedColumnType(column.name),
          required: false,
          selected: true,
          excel_name: column.name,
          transform_rule: "无需转换",
        }));
        const uidField = fields.find((field) => String(field.excel_name || "").trim().toLowerCase() === "uid" || field.technical_name === "uid");
        const primaryKey = uidField?.technical_name || fields.find((field) => field.technical_name === "employee_id")?.technical_name || fields[0]?.technical_name;
        const technicalName = `input_${Date.now().toString(36)}_${sourceIndex + 1}`;
        const displayName = dataTableDisplayName(source.fileName, source.sheetName, uploadSources.length);
        const response = await localApiFetch("http://127.0.0.1:8787/api/data/pages", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ technical_name: technicalName, display_name: displayName, data_role: "输入子表", selected_sheet: source.sheetName, source_file: source.fileName, primary_key: primaryKey, fields }),
        });
        const payload = await response.json();
        if (response.status === 404 && payload.error === "未找到接口") {
          throw new Error("本地后端仍在运行旧版本，缺少“创建数据表”接口。请停止当前服务后重新打开 start_payroll.command，再重新上传并创建数据表");
        }
        if (!response.ok) throw new Error(payload.error || `数据表“${displayName}”创建失败`);
        created.push(toClientTable({ ...payload, primary_keys: [payload.primary_key], created_at: new Date().toLocaleString("zh-CN", { hour12: false }) }));
        appendDataLog("success", "数据表结构已创建", `数据表：${displayName}；Sheet：${source.sheetName}；表头第 ${source.headerRow || 1} 行；${fields.length} 个字段`);
      }
      setTables((items) => {
        const createdNames = new Set(created.map((item) => item.technical));
        return [...created, ...items.filter((item) => !createdNames.has(item.technical))];
      });
      setSelectedFieldCounts((counts) => ({ ...counts, ...Object.fromEntries(created.map((item) => [item.technical, item.fieldMappings.length])) }));
      setPrimaryKeys((keys) => ({ ...keys, ...Object.fromEntries(created.map((item) => [item.technical, item.primaryKey])) }));
      setSelected(created[0]?.name || "");
      setUploadOpen(false);
      onNotify(`已创建 ${created.length} 张数据表，后续可进入表详情导入正式数据`);
    } catch (error) {
      appendDataLog("error", "数据表结构创建失败", error.message);
      onNotify(`数据表创建失败：${error.message}`);
    }
  };
  const updateColumnMapping = (columnRef, fieldKey) => {
    setMappingDraft((mapping) => {
      const next = Object.fromEntries(Object.entries(mapping).filter(([, mappedColumn]) => mappedColumn !== columnRef));
      if (fieldKey) next[fieldKey] = columnRef;
      return next;
    });
  };
  const updateFieldMapping = (fieldKey, columnRef) => {
    setMappingDraft((mapping) => {
      const next = Object.fromEntries(Object.entries(mapping).filter(([key, value]) => key === fieldKey || value !== columnRef));
      if (columnRef) next[fieldKey] = columnRef;
      return next;
    });
  };
  const removeTable = async (event, table) => {
    event.stopPropagation();
    if (
      !window.confirm(
        `确定删除已确认数据表“${table.name}”吗？这会同时移除当前组织中对应的 Schema 和业务表。`,
      )
    )
      return;
    try {
      const response = await localApiFetch(
        `http://127.0.0.1:8787/api/data/pages?technical_name=${encodeURIComponent(table.technical)}`,
        { method: "DELETE" },
      );
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || "数据表删除失败");
      const remaining = tables.filter((item) => item.technical !== table.technical);
      setTables(remaining);
      if (selected === table.name) setSelected(remaining[0]?.name || "");
      appendDataLog("success", "数据表已删除", `数据表：${table.name}（${table.technical}）`);
      onNotify(`已删除数据表：${table.name}`);
    } catch (error) {
      appendDataLog("error", "数据表删除失败", error.message);
      onNotify(`数据表删除失败：${error.message}`);
    }
  };
  return (
    <section className="page-frame">
      <PageHeading
        title="数据"
        description="导入参与核算的数据源模板，识别并确认 Sheet、字段、类型、映射和主键。本页面只保存表结构，不读取或写入真实业务数据。"
      >
        <button className="button primary" onClick={openUpload}>
          <Plus size={16} />
          新建数据表
        </button>
      </PageHeading>
      <div className="data-layout">
        <section className="panel table-list">
          <div className="panel-title">
            <div>
              <h2>数据表</h2>
              <p>{sourceTables.length} 张来源表 · {confirmedCount} 张已确认表结构</p>
            </div>
          </div>
          {sourceTables.length ? (
            sourceTables.map((table) => (
              <div
                key={table.technical}
                className={`data-table-row ${selected === table.name ? "selected" : ""}`}
                onClick={() => setSelected(table.name)}
                role="button"
                tabIndex="0"
              >
                <span className="table-icon">
                  <Table2 size={18} />
                </span>
                <div>
                  <strong>{table.name}</strong>
                  <span>
                    {table.technical} · 已选用 {selectedFieldCounts[table.technical]} 个字段 · {table.type}
                  </span>
                </div>
                <Status label="表结构" status={table.schemaStatus} />
                <button
                  className="row-delete"
                  aria-label={`删除${table.name}`}
                  onClick={(event) => removeTable(event, table)}
                >
                  <Trash2 size={15} />
                </button>
                <ArrowRight size={15} />
              </div>
            ))
          ) : (
            <div className="empty-table">
              <Database size={24} />
              <strong>还没有已确认数据表</strong>
              <span>上传数据源模板，识别字段并确认表结构。</span>
              <button className="button secondary compact" onClick={openUpload}>
                <Upload size={15} />
                上传第一个模板
              </button>
            </div>
          )}
        </section>
        {current && (
          <aside className="data-detail">
            <section className="panel schema-panel">
              <div className="panel-title">
                <TableIdentity table={current} existingTableNames={tables.map((item) => item.technical)} onRename={(name, technical) => { setTables((items) => items.map((item) => item.technical === current.technical ? { ...item, name, technical } : item)); setSelected(name); }} />
                <Status label="表结构" status={currentSchemaStatus} />
              </div>
              <div className="schema-stat">
                <div>
                  <span>结构状态</span>
                  <strong>{currentSchemaStatus}</strong>
                </div>
                <div>
                  <span>模板 Sheet</span>
                  <strong>{current.selectedSheet || "未记录"}</strong>
                </div>
                <div>
                  <span>数据库表</span>
                  <strong>{current.technical}</strong>
                </div>
                <div>
                  <span>已选用列数</span>
                  <strong>{selectedFieldCounts[current.technical]} 个字段</strong>
                </div>
              </div>
              <div className="field-list">
                <div className="field-head">
                  <span>字段</span>
                  <span>类型</span>
                  <span>必填</span>
                </div>
                {(current.fieldMappings || tableMappings[current.technical] || []).map((field) => <Field key={field.db} name={field.db} type={field.dbType} excelName={field.excel} excelType={field.excelType} transform={field.transform} required={field.required} used={usedFields[`${current.technical}.${field.db}`] ?? usedFields[field.db] ?? true} onUsedChange={(value) => updateFieldUse(field.db, value)} />)}
              </div>
              <div className="primary-key-panel">
                <div><strong>主键字段</strong><span>每张数据表必须选择一个字段作为唯一标识，用于匹配明细、更新和跨表关联。</span></div>
                <select value={primaryKeys[current.technical] || ""} onChange={(event) => setPrimaryKeys((items) => ({ ...items, [current.technical]: event.target.value }))}>
                  <option value="">请选择主键字段</option>
                  {(current.fieldMappings || tableMappings[current.technical] || []).map((field, index) => <option value={field.db} key={`${field.db}-${field.excel}-${index}`}>{field.excel} · {field.db}</option>)}
                </select>
                <small>{primaryKeys[current.technical] ? `当前主键：${primaryKeys[current.technical]}` : "尚未选择主键"}</small>
                <button className="button secondary" disabled={!primaryKeys[current.technical]} onClick={savePrimaryKey}><Check size={15} />保存主键</button>
              </div>
              <div className="panel-actions">
                <SchemaConfirmationAction
                  key={current.technical}
                  initialConfirmed={schemaConfirmed}
                  initialConfirmedAt={current.updated}
                  onNotify={onNotify}
                onConfirmed={() => { if (!primaryKeys[current.technical]) { onNotify("请先选择一个主键字段"); return false; } setTables((items) => items.map((item) => item.technical === current.technical ? { ...item, schemaStatus: "已确认", primaryKey: primaryKeys[current.technical] } : item)); return true; }}
                />
              </div>
            </section>
            <section className="import-note">
              <ShieldCheck size={18} />
              <div>
                <strong>这里只确认数据源结构</strong>
                <p>
                  模板仅用于识别 Sheet、表头和字段类型，不会在此页面导入业务行。真实数据请在“数据导入”页处理。
                </p>
              </div>
            </section>
          </aside>
        )}
        <OperationLogPanel
          title="数据操作日志"
          description="记录当前组织的数据源模板解析、Sheet 与表头识别、字段映射及 Schema 确认状态，不记录业务数据导入。"
          entries={dataLogs}
          onClear={() => setDataLogs([])}
        />
      </div>
      {uploadOpen && (
        <div className="dialog-backdrop" role="presentation">
          <section
            className="upload-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="upload-title"
          >
            <div className="dialog-heading">
              <div>
                <h2 id="upload-title">{activeUploadItem ? `导入并映射：${activeUploadItem.title}` : "上传数据模板"}</h2>
                <p>{activeUploadItem ? "请先查看并确认本项目需要的标准字段，再在下方上传 Excel；上传后将“待映射”改为对应的文件名.列名。" : "选择本地 Excel 或 CSV 文件，并确认用于建立表结构的 Sheet。"}</p>
              </div>
              <button
                className="icon-button"
                aria-label="关闭上传对话框"
                onClick={() => setUploadOpen(false)}
              >
                <X size={17} />
              </button>
            </div>
            <button
              className="dropzone"
              onClick={() => fileInput.current?.click()}
            >
              <Upload size={25} />
              <strong>
                {uploadSources.length ? `已添加 ${uploadSources.length} 个 Excel 文件，点击继续添加` : "选择本地 Excel 文件"}
              </strong>
              <span>
                {uploadSources.length ? "每个文件可单独选择 Sheet，列映射会合并显示" : "支持 .xlsx、.xls、.csv 格式，可重复添加多个文件"}
              </span>
            </button>
            <input
              ref={fileInput}
              className="hidden-file"
              type="file"
              accept=".xlsx,.xls,.csv"
              multiple
              onChange={handleFiles}
            />
            {uploadSources.length > 0 && <div className="upload-source-list">
              {uploadSources.map((source) => <div className="upload-source-row" key={source.id}>
                <div><strong>{source.fileName}</strong><small>{source.columns.length ? `${source.columns.length} 列 · 已识别第 ${source.headerRow || 1} 行为表头` : source.error || "请选择 Sheet"}</small></div>
                {source.sheets.length > 1 ? <select value={source.sheetName} onChange={(event) => updateUploadSourceSheet(source.id, event.target.value)}><option value="">请选择 Sheet</option>{source.sheets.map((sheetName) => <option key={`${source.id}-${sheetName}`} value={sheetName}>{sheetName}</option>)}</select> : <span className="selected-sheet">{source.sheetName ? `Sheet：${source.sheetName}` : "无可用 Sheet"}</span>}
                <button type="button" className="small-icon" aria-label={`移除${source.fileName}`} onClick={() => removeUploadSource(source.id)}><X size={14} /></button>
              </div>)}
            </div>}
            {uploadSources.length > 0 && !activeUploadItem && <div className="template-analysis-preview">
              <div className="column-preview-heading">
                <strong>模板解析结果</strong>
                <span>{uploadColumnOptions.length} 列 · {uploadSources.length} 个文件</span>
              </div>
              {uploadSources.map((source) => <div className="template-analysis-source" key={`preview-${source.id}`}>
                <div>
                  <strong>{source.fileName}</strong>
                  <small>{source.sheetName ? `Sheet：${source.sheetName} · 第 ${source.headerRow || 1} 行识别为表头` : "请选择 Sheet 后解析列名"}</small>
                </div>
                {source.columns.length > 0 && <div className="template-column-tags">{source.columns.map((column) => <span key={`${source.id}-${column.index}-${column.name}`}>{column.name}</span>)}</div>}
              </div>)}
            </div>}
            {activeUploadItem && (
              <div className="column-preview">
                <div className="column-preview-heading">
                  <strong>标准字段映射</strong>
                  <span>{uploadColumnOptions.length} 列 · {uploadSources.length} 个文件</span>
                </div>
                {activeUploadItem ? (
                  <div className="column-table required-field-mapping-table">
                    <div className="column-table-head">
                      <span>标准字段</span>
                      <span>要求</span>
                      <span>Excel 文件名.列名</span>
                    </div>
                    {activeUploadItem.fields.map((field) => {
                      const mappedColumn = uploadColumnOptions.find((column) => column.ref === mappingDraft[field.key]);
                      return <div className="column-table-row" key={field.key}>
                        <strong>{field.label}</strong>
                        <span className={field.required ? "required-label" : "optional-label"}>{field.required ? "必填" : "可选"}{field.neededByOutput && <small className="output-needed-label">输出需要</small>}{field.default !== undefined && <small>默认：{field.default === "按核算月份双休" ? "核算月份双休" : field.default}</small>}</span>
                        <select className={mappedColumn ? "mapped-field-select is-mapped" : "mapped-field-select"} value={mappingDraft[field.key] || ""} onChange={(event) => updateFieldMapping(field.key, event.target.value)}>
                          <option value="">待映射</option>
                          {uploadColumnOptions.map((column) => <option value={column.ref} key={`${field.key}-${column.ref}`}>{column.matchLabel}</option>)}
                        </select>
                      </div>;
                    })}
                  </div>
                ) : null}
              </div>
            )}
            <div className="dialog-note">
              <ShieldCheck size={16} />
              文件只用于当前组织的结构分析，不会在页面展示完整业务明细。
            </div>
            <div className="dialog-actions">
              <button
                className="button secondary"
                onClick={() => setUploadOpen(false)}
              >
                取消
              </button>
              <button
                className="button primary"
                disabled={!uploadSources.length || !uploadColumnOptions.length || (activeUploadItem && uploadSources.some((source) => !source.sheetName || !source.columns.length))}
                onClick={activeUploadItem ? confirmRequiredItemMapping : createTablesFromTemplate}
              >
                {activeUploadItem ? "确认字段映射" : "创建数据表"}
              </button>
            </div>
          </section>
        </div>
      )}
    </section>
  );
}

function DataImportPage({ tables, setTables, onNotify, onNavigate }) {
  const confirmedTables = useMemo(() => tables.filter((table) => table.schemaStatus === "已确认" && Array.isArray(table.fieldMappings) && table.fieldMappings.length > 0), [tables]);
  const allTablesImported = confirmedTables.length > 0 && confirmedTables.every((table) => table.importStatus === "已导入");
  const [selectedTableName, setSelectedTableName] = useState("");
  const [importOpen, setImportOpen] = useState(false);
  const [importLogs, setImportLogs] = useState([]);
  const current = confirmedTables.find((table) => table.name === selectedTableName) || confirmedTables[0];
  const appendImportLog = (level, message, detail = "") => setImportLogs((logs) => [{ id: `import-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, level, message, detail, createdAt: new Date().toLocaleString("zh-CN", { hour12: false }), source: "本次操作" }, ...logs].slice(0, 80));

  useEffect(() => {
    let active = true;
    localApiFetch("http://127.0.0.1:8787/api/audit")
      .then((response) => response.ok ? response.json() : Promise.reject(new Error("数据导入记录读取失败")))
      .then((payload) => {
        if (!active) return;
        const history = (payload.items || []).flatMap((item) => {
          if (!["data_imported", "data_import_failed"].includes(item.event_type)) return [];
          let details = {};
          try { details = JSON.parse(item.payload_json || "{}"); } catch { details = {}; }
          return [{
            id: `import-audit-${item.audit_id}`,
            level: item.event_type === "data_imported" ? "success" : "error",
            message: item.event_type === "data_imported" ? "真实业务数据导入完成" : "真实业务数据导入失败",
            detail: [details.source_file ? `文件：${details.source_file}` : "", details.sheet_name ? `Sheet：${details.sheet_name}` : "", details.record_count !== undefined ? `记录：${details.record_count} 条` : "", details.error ? `原因：${details.error}` : ""].filter(Boolean).join("；"),
            createdAt: item.created_at || "历史记录",
            source: "已保存",
          }];
        });
        setImportLogs(history.slice(0, 80));
      })
      .catch((error) => appendImportLog("error", "无法读取数据导入记录", error.message));
    return () => { active = false; };
  }, []);

  const refreshTables = async () => {
    const response = await localApiFetch("http://127.0.0.1:8787/api/data/pages");
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || "数据表状态读取失败");
    const restored = (payload.items || []).map(toClientTable);
    setTables(restored);
    return restored;
  };

  return (
    <section className="page-frame data-import-page">
      <PageHeading
        title="数据导入"
        description="在核算逻辑完成后导入真实业务数据。系统只使用本地 Python 读取文件，先与“数据”页确认的 Schema 做严格一致性校验，通过后才写入当前组织的 SQLite 数据表。"
      >
        <button className="button primary" disabled={!allTablesImported} onClick={() => onNavigate?.("run")}><Play size={15} />完成计算</button>
      </PageHeading>
      <div className="data-import-flow" aria-label="数据导入安全流程">
        <div><span>1</span><strong>选择已确认数据表</strong><small>读取本地 Schema</small></div>
        <ChevronRight size={16} />
        <div><span>2</span><strong>严格校验表结构</strong><small>字段必须完全一致</small></div>
        <ChevronRight size={16} />
        <div><span>3</span><strong>本地 Python 写入</strong><small>全程不调用 AI</small></div>
      </div>
      <div className="data-layout data-import-layout">
        <section className="panel table-list">
          <div className="panel-title"><div><h2>已确认的数据源表</h2><p>{confirmedTables.length} 张表可导入真实业务数据</p></div></div>
          {confirmedTables.length ? confirmedTables.map((table) => (
            <div key={table.technical} className={`data-table-row ${current?.technical === table.technical ? "selected" : ""}`} onClick={() => setSelectedTableName(table.name)} role="button" tabIndex="0">
              <span className="table-icon"><Database size={18} /></span>
              <div><strong>{table.name}</strong><span>{table.technical} · {table.fieldMappings?.length || 0} 个已确认字段</span></div>
              <Status label="业务数据" status={table.importStatus} />
              <ArrowRight size={15} />
            </div>
          )) : <div className="empty-table"><FileCheck2 size={24} /><strong>没有可导入的数据表</strong><span>请先到“数据”页导入并确认数据源表结构。</span></div>}
        </section>
        {current && <aside className="data-detail">
          <section className="panel schema-panel data-import-target">
            <div className="panel-title"><div><h2>{current.name}</h2><p>目标表：{current.technical}</p></div><Status status={current.importStatus} /></div>
            <div className="schema-stat import-readiness-stat">
              <div><span>结构状态</span><strong>{current.schemaStatus}</strong></div>
              <div><span>确认 Sheet</span><strong>{current.selectedSheet || "未记录"}</strong></div>
              <div><span>确认字段</span><strong>{current.fieldMappings?.length || 0} 个</strong></div>
              <div><span>唯一主键</span><strong>{current.primaryKey || "未设置"}</strong></div>
              <div><span>当前有效记录</span><strong>{current.records}</strong></div>
              <div><span>最近导入</span><strong>{current.lastImport?.importedAt || "尚未导入"}</strong></div>
            </div>
            <div className="import-schema-preview">
              <div className="field-head"><span>模板字段</span><span>数据库字段</span><span>类型</span></div>
              {(current.fieldMappings || []).map((field) => <div className="import-schema-row" key={`${current.technical}-${field.db}`}><span>{field.excel}</span><code>{field.db}</code><span>{field.dbType}</span></div>)}
            </div>
            <div className="panel-actions"><ImportDataAction table={current} schemaConfirmed={current.schemaStatus === "已确认" && Boolean(current.primaryKey)} onImport={() => setImportOpen(true)} /></div>
          </section>
          <section className="import-note privacy-boundary-note"><ShieldCheck size={18} /><div><strong>真实数据隐私边界</strong><p>浏览器只把文件交给当前电脑上的 Python 服务；导入接口不会调用 AI。结构不一致、主键缺失、主键重复或字段类型转换失败时，整个事务都会回滚。</p></div></section>
        </aside>}
        <OperationLogPanel title="真实数据导入日志" description="只保存文件名、表名、批次、记录数量和错误摘要，不展示或保存业务明细到前端日志。" entries={importLogs} onClear={() => setImportLogs([])} />
      </div>
      {importOpen && current && <DataImportDialog table={current} onClose={() => setImportOpen(false)} onNotify={onNotify} onLog={appendImportLog} onImported={async (record) => {
        try {
          const restored = await refreshTables();
          appendImportLog("success", "数据表状态已刷新", `已刷新 ${restored.length} 张数据表；本次写入 ${record.recordCount}。`);
        } catch (error) {
          appendImportLog("warning", "数据已导入，但页面状态刷新失败", error.message);
          onNotify(`数据已导入，但状态刷新失败：${error.message}`);
        }
      }} />}
    </section>
  );
}

function Field({ name, type, excelName: providedExcelName, excelType: providedExcelType, transform: providedTransform, required, used = true, onUsedChange }) {
  const mapping = Object.values(tableMappings)
    .flat()
    .find((field) => field.db === name);
  const [editing, setEditing] = useState(false);
  const [dbName, setDbName] = useState(mapping?.db || name);
  const [dbType, setDbType] = useState(mapping?.dbType || type);
  const excelName = providedExcelName || mapping?.excel || "系统生成";
  const excelType = providedExcelType || mapping?.excelType || "未知";
  const transform = providedTransform || mapping?.transform || "待确认";
  const defaultValue = mapping?.defaultValue || "—";
  return (
    <>
      <div className={`field-row ${used ? "field-used" : "field-unused"}`}>
        <span className="field-excel-name"><input className="field-use" type="checkbox" checked={used} onChange={(event) => onUsedChange?.(event.target.checked)} aria-label={`使用${excelName}`} /><span>{excelName}</span><small>默认：{defaultValue}</small></span>
        <span className="field-excel-type">{excelType}</span>
        <code className="field-db-name">{dbName}</code>
        <span className="field-db-type">{dbType}</span>
        <button className="field-edit" onClick={() => setEditing(true)}>
          修改
        </button>
      </div>
      {editing && (
        <div className="field-edit-backdrop">
          <section
            className="field-edit-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby={`edit-${name}`}
          >
            <div className="dialog-heading">
              <div>
                <h2 id={`edit-${name}`}>修改数据库字段</h2>
                <p>
                  Excel 列名和 Excel 数据类型来自上传文件，不支持在这里修改。
                </p>
              </div>
              <button
                className="icon-button"
                aria-label="关闭字段修改对话框"
                onClick={() => setEditing(false)}
              >
                <X size={17} />
              </button>
            </div>
            <label className="edit-field">
              <span>数据库字段名</span>
              <input
                value={dbName}
                onChange={(event) => setDbName(event.target.value)}
              />
            </label>
            <label className="edit-field">
              <span>数据库字段类型</span>
              <select
                value={dbType}
                onChange={(event) => setDbType(event.target.value)}
              >
                <option value="TEXT">TEXT · 文本</option>
                <option value="REAL">REAL · 数值</option>
                <option value="INTEGER">INTEGER · 整数</option>
                <option value="DATE">DATE · 日期</option>
                <option value="BOOLEAN">BOOLEAN · 布尔</option>
              </select>
            </label>
            <div className="edit-preview">
              <span>Excel 映射</span>
              <strong>
                {excelName} · {excelType}
              </strong>
              <small>
                转换规则：{transform} · {required ? "必填" : "可选"}
              </small>
            </div>
            <div className="dialog-actions">
              <button
                className="button secondary"
                onClick={() => setEditing(false)}
              >
                取消
              </button>
              <button
                className="button primary"
                onClick={() => setEditing(false)}
              >
                保存修改
              </button>
            </div>
          </section>
        </div>
      )}
    </>
  );
}

function OperationLogPanel({ title = "操作日志", description, entries, onClear }) {
  return <section className="panel operation-log-panel">
    <div className="panel-title">
      <div>
        <h2><ScrollText size={17} />{title}</h2>
        <p>{description || "仅展示操作状态、处理摘要和错误原因，不展示原始业务数据。"}</p>
      </div>
      {entries.length > 0 && <button className="button secondary compact" onClick={onClear}>清空本次日志</button>}
    </div>
    <div className="operation-log-list" aria-live="polite">
      {entries.length ? entries.map((entry) => <article className={`operation-log-row is-${entry.level || "info"}`} key={entry.id}>
        <span className="operation-log-level" aria-hidden="true" />
        <div>
          <strong>{entry.message}</strong>
          {entry.detail && <small>{entry.detail}</small>}
        </div>
        <time>{entry.createdAt}</time>
      </article>) : <div className="operation-log-empty">暂无本次页面操作记录。执行上传、保存、生成或核算后，状态和错误会显示在这里。</div>}
    </div>
  </section>;
}

function OutputPage({ onNotify, customOutputs, setCustomOutputs }) {
  const [selectedFields, setSelectedFields] = useState(() => new Set());
  const [outputOrder, setOutputOrder] = useState([]);
  const [fieldsConfirmed, setFieldsConfirmed] = useState(false);
  const [draggedKey, setDraggedKey] = useState("");
  const [draggedHeaderId, setDraggedHeaderId] = useState("");
  const [headerGroups, setHeaderGroups] = useState([]);
  const [layoutOrder, setLayoutOrder] = useState([]);
  const [headerDialogOpen, setHeaderDialogOpen] = useState(false);
  const [headerTitle, setHeaderTitle] = useState("");
  const [outputSaved, setOutputSaved] = useState(false);
  const [saveRecordOpen, setSaveRecordOpen] = useState(false);
  const [savedAt, setSavedAt] = useState("");
  const [templateDialogOpen, setTemplateDialogOpen] = useState(false);
  const [templateFile, setTemplateFile] = useState(null);
  const [templateSheet, setTemplateSheet] = useState("");
  const [templateSheets, setTemplateSheets] = useState([]);
  const [templateColumns, setTemplateColumns] = useState([]);
  const [templateOutputFields, setTemplateOutputFields] = useState([]);
  const [outputLogs, setOutputLogs] = useState([]);
  const templateInputRef = useRef(null);
  const appendOutputLog = (level, message, detail = "") => setOutputLogs((logs) => [{ id: `output-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, level, message, detail, createdAt: new Date().toLocaleString("zh-CN", { hour12: false }) }, ...logs].slice(0, 80));
  useEffect(() => {
    setTemplateOutputFields((current) => {
      if (!current.some((field) => /^output_field_\d+$/.test(field.name))) return current;
      const usedNames = new Set();
      return current.map((field, position) => {
        const matchedIndex = Number(String(field.key || "").split(".").at(-1));
        return { ...field, name: makeOutputFieldName(field.label, Number.isFinite(matchedIndex) ? matchedIndex : position, usedNames) };
      });
    });
  }, []);
  useEffect(() => {
    let cancelled = false;
    const restoreSavedOutputSchema = async () => {
      try {
        const schemaResponse = await localApiFetch("http://127.0.0.1:8787/api/output/schema");
        const schema = schemaResponse.ok ? await schemaResponse.json() : null;
        if (cancelled || !schema || !Array.isArray(schema.fields) || !schema.fields.length) return;

        let savedRules = { items: [] };
        try {
          const rulesResponse = await localApiFetch("http://127.0.0.1:8787/api/output/field-rules");
          if (rulesResponse.ok) savedRules = await rulesResponse.json();
        } catch {
          // 输出字段规则是核算页的附加信息，不能阻断输出表结构恢复。
        }

        const savedRuleMap = new Map((savedRules.items || []).map((item) => [item.field_name, item]));
        const persistedTemplateFields = schema.fields
          .filter((field) => field.source !== "custom")
          .map((field, index) => ({
            key: `template.persisted.${index}`,
            name: field.name,
            label: field.display_name || field.name,
            type: field.sqlite_type || "TEXT",
            persisted: true,
          }));
        const persistedTemplateKeys = persistedTemplateFields.map((field) => field.key);
        const persistedCustomOutputs = schema.fields
          .filter((field) => field.source === "custom")
          .map((field) => {
            const savedRule = savedRuleMap.get(field.name) || {};
            return {
              name: field.name,
              type: field.sqlite_type || "TEXT",
              logicName: savedRule.logic_name || `calculate_${field.name}`,
              description: savedRule.description || "",
              generatedCode: savedRule.generated_code || "",
              status: savedRule.status || "待配置",
            };
          });

        setTemplateOutputFields(persistedTemplateFields);
        setSelectedFields(new Set(persistedTemplateKeys));
        setOutputOrder(persistedTemplateKeys);
        setLayoutOrder(persistedTemplateKeys);
        setHeaderGroups(Array.isArray(schema.header_groups) ? schema.header_groups : []);
        setFieldsConfirmed(true);
        setOutputSaved(true);
        setSavedAt(schema.saved_at || "");
        if (persistedCustomOutputs.length) {
          setCustomOutputs((current) => {
            const currentMap = new Map(current.map((item) => [item.name, item]));
            persistedCustomOutputs.forEach((item) => currentMap.set(item.name, { ...currentMap.get(item.name), ...item }));
            return Array.from(currentMap.values());
          });
        }
        appendOutputLog("success", "已恢复已保存的输出结构", `当前组织：${persistedTemplateFields.length + persistedCustomOutputs.length} 个字段；结构版本：${schema.version || 0}`);
      } catch (error) {
        if (!cancelled) appendOutputLog("error", "输出结构恢复失败", error.message);
      }
    };
    restoreSavedOutputSchema();
    return () => { cancelled = true; };
  }, []);
  const resolvedTemplateOutputFields = useMemo(() => {
    const usedNames = new Set();
    return templateOutputFields.map((field, position) => {
      const matchedIndex = Number(String(field.key || "").split(".").at(-1));
      return { ...field, name: field.persisted && field.name ? field.name : makeOutputFieldName(field.label, Number.isFinite(matchedIndex) ? matchedIndex : position, usedNames) };
    });
  }, [templateOutputFields]);
  const toggleField = (key) => setSelectedFields((previous) => {
    const next = new Set(previous);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });
  const confirmOutputFields = () => {
    if (!selectedFields.size) { appendOutputLog("error", "输出字段未确认", "请至少选择一个输出字段"); onNotify("请至少选择一个输出字段"); return; }
    setLayoutOrder(outputOrder.filter((key) => selectedFields.has(key)));
    setFieldsConfirmed(true);
    appendOutputLog("success", "输出字段选择已确认", `已选择 ${selectedFields.size} 个字段，等待最终保存并更新数据库结构`);
    onNotify(`已确认 ${selectedFields.size} 个输出字段，可继续调整输出顺序`);
  };
  const addHeaderGroup = () => {
    if (outputSaved) return;
    if (!headerTitle.trim()) { onNotify("请填写大标题名称"); return; }
    const id = `header-${Date.now()}`;
    setHeaderGroups((groups) => [...groups, { id, title: headerTitle.trim() }]);
    setLayoutOrder((items) => [...items, `header:${id}`]);
    setHeaderTitle(""); setHeaderDialogOpen(false);
    onNotify(`已插入大标题“${headerTitle.trim()}”，请拖动它到需要覆盖的字段之前`);
  };
  const saveOutputPlan = async () => {
    if (!fieldsConfirmed) { appendOutputLog("error", "输出方案未保存", "请先确认输出字段和排序位置"); onNotify("请先确认输出字段和排序位置"); return; }
    const timestamp = new Date().toLocaleString("zh-CN", { hour12: false });
    const fieldMap = new Map(resolvedTemplateOutputFields.map((field) => [field.key, { ...field, source: "输出模板" }]));
    const fields = layoutOrder.filter((key) => fieldMap.has(key)).map((key) => { const field = fieldMap.get(key); return { name: field.name, sqlite_type: field.type === "DATE" || field.type === "BOOLEAN" ? "TEXT" : field.type, display_name: field.label, source: field.source }; }).concat(customOutputs.map((item) => ({ name: item.name, sqlite_type: item.type, display_name: item.name, source: "custom" })));
    try {
      appendOutputLog("info", "正在保存输出方案", `准备按当前顺序更新 SQLite 结果表，共 ${fields.length} 个字段`);
      const response = await localApiFetch("http://127.0.0.1:8787/api/output/schema", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ schema_name: "local_calculation_result", ordered_fields: fields, excel_header_groups: headerGroups, template_file: templateFile?.name || "" }) });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "输出方案保存失败");
      setSavedAt(timestamp); setOutputSaved(true); appendOutputLog("success", "输出方案已写入 SQLite", `版本：${payload.version}；结果字段：${fields.length} 个`); onNotify(`输出方案已写入 SQLite，版本 ${payload.version}`);
    } catch (error) { appendOutputLog("error", "输出方案保存失败", error.message); onNotify(`输出方案保存失败：${error.message}`); }
  };
  const readOutputTemplate = async (file, sheetOverride = "") => {
    const workbook = XLSX.read(await file.arrayBuffer(), { type: "array" });
    const sheets = workbook.SheetNames || [];
    const sheet = sheetOverride || sheets[0] || "";
    const rows = sheet ? XLSX.utils.sheet_to_json(workbook.Sheets[sheet], { header: 1, defval: "" }) : [];
    const candidates = rows.slice(0, 8).map((row, rowIndex) => { const values = Array.isArray(row) ? row.map((value) => String(value ?? "").trim()) : []; const nonEmpty = values.filter(Boolean); const matches = nonEmpty.reduce((count, value) => count + (suggestFieldName(value) ? 1 : 0), 0); return { rowIndex, values, score: matches * 10 + Math.min(nonEmpty.length, 12) }; }).filter((candidate) => candidate.values.some(Boolean));
    const best = candidates.sort((a, b) => b.score - a.score)[0];
    const names = best?.values.filter(Boolean) || [];
    const next = names.map((name, index) => ({ name, index, mappedKey: `template.${index}`, selected: true }));
    setTemplateFile(file); setTemplateSheets(sheets); setTemplateSheet(sheet); setTemplateColumns(next); setTemplateDialogOpen(true);
    appendOutputLog(next.length ? "success" : "error", next.length ? "输出模板解析完成" : "输出模板未识别到表头", `文件：${file.name}；Sheet：${sheet || "未找到"}；${next.length ? `第 ${(best?.rowIndex || 0) + 1} 行识别为表头，共 ${next.length} 列` : "请检查模板内容"}`);
  };
  const applyOutputTemplate = () => {
    const selected = templateColumns.filter((column) => column.selected);
    if (!selected.length) { appendOutputLog("error", "输出模板未应用", "请至少选择一个模板列作为输出字段"); onNotify("请至少选择一个模板列作为输出字段"); return; }
    const usedNames = new Set();
    const nextTemplateFields = selected.map((column) => ({ key: column.mappedKey, name: makeOutputFieldName(column.name, column.index, usedNames), label: column.name, type: "TEXT" }));
    setTemplateOutputFields(nextTemplateFields);
    setSelectedFields(new Set(nextTemplateFields.map((field) => field.key)));
    setOutputOrder(nextTemplateFields.map((field) => field.key));
    setFieldsConfirmed(false); setOutputSaved(false); setTemplateDialogOpen(false);
    appendOutputLog("success", "输出模板已应用", `文件：${templateFile?.name || "未命名模板"}；已载入 ${selected.length} 个模板字段`);
    onNotify(`已载入输出模板：${templateFile?.name || "未命名模板"}，可继续增减输出字段`);
  };
  const reorderLayout = (target) => {
    const dragged = draggedHeaderId ? `header:${draggedHeaderId}` : draggedKey;
    if (!dragged || dragged === target) return;
    setLayoutOrder((items) => {
      const next = items.filter((item) => item !== dragged);
      const index = next.indexOf(target);
      if (index < 0) return items;
      next.splice(index, 0, dragged);
      return next;
    });
    setDraggedKey(""); setDraggedHeaderId("");
  };
  const [customName, setCustomName] = useState("");
  const [customType, setCustomType] = useState("REAL");
  const addCustomOutput = () => {
    const name = customName.trim().toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^\d+/, "field_");
    if (!name) { onNotify("请先填写自定义输出字段名"); return; }
    if (customOutputs.some((item) => item.name === name) || resolvedTemplateOutputFields.some((item) => item.name === name)) { onNotify("自定义输出字段名不能重复"); return; }
    const logicName = `calculate_${name}`;
    setCustomOutputs((items) => [...items, { name, type: customType, logicName, description: "", status: "待解析" }]);
    setCustomName("");
    onNotify(`已增加字段 ${name}，请到核算页面描述 ${logicName} 的计算逻辑`);
  };
  return (
    <section className="page-frame">
      <PageHeading
        title="输出目标"
        description="导入并确认最终需要输出的表结构、字段顺序与标题布局；确认后的输出目标将作为核算结果表和导出文件的唯一结构标准。"
      >
        <button className="button secondary" onClick={() => templateInputRef.current?.click()}><Upload size={15} />导入输出模板</button>
        <input ref={templateInputRef} className="hidden-file" type="file" accept=".xlsx,.xls,.csv" onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; if (file) readOutputTemplate(file).catch((error) => { appendOutputLog("error", "输出模板解析失败", `文件：${file.name}；原因：${error.message}`); onNotify(`输出模板解析失败：${error.message}`); }); }} />
        <button
          className="button primary"
          onClick={() => outputSaved ? setSaveRecordOpen(true) : saveOutputPlan()}
        >
          <Check size={16} />
          {outputSaved ? "查看保存记录" : "确认输出模板并更新数据库"}
        </button>
      </PageHeading>
      <div className="output-grid">
        <section className="panel output-fields output-source-panel">
          <div className="panel-title">
            <div>
              <h2>输出模板字段</h2>
              <p>{fieldsConfirmed ? `已固定 ${selectedFields.size} 个模板输出字段 · 可调整输出顺序` : resolvedTemplateOutputFields.length ? `已载入模板字段 · 当前选择 ${selectedFields.size} 个` : "请先导入输出模板，页面不会自动关联数据页字段"}</p>
            </div>
            <Status status={fieldsConfirmed ? "已确认" : "待确认"} />
          </div>
          <div className="output-confirm-bar"><span>{fieldsConfirmed ? (outputSaved ? "输出方案已保存定稿，如需修改请先选择重新配置。" : "字段方案已固定；数据库将在点击顶部最终确认按钮后更新。") : "请勾选需要输出的字段，当前调整只保存在页面，尚不会修改 SQLite。"}</span><div className="output-confirm-actions">{fieldsConfirmed && <button className="button secondary compact" disabled={outputSaved} onClick={() => setHeaderDialogOpen(true)}><Plus size={14} />插入大标题</button>}<button className={`button ${fieldsConfirmed ? "secondary" : "primary"} compact`} disabled={outputSaved} onClick={() => fieldsConfirmed ? setFieldsConfirmed(false) : confirmOutputFields()}>{fieldsConfirmed ? "调整字段选择" : "确认输出字段"}</button></div></div>
          {fieldsConfirmed ? <div className="confirmed-output-list">
            {layoutOrder.map((item) => {
              if (item.startsWith("header:")) {
                const group = headerGroups.find((groupItem) => `header:${groupItem.id}` === item);
                if (!group) return null;
                return <div className={`output-header-group ${draggedHeaderId === group.id ? "is-dragging" : ""}`} key={item} draggable onDragStart={() => setDraggedHeaderId(group.id)} onDragOver={(event) => event.preventDefault()} onDrop={() => reorderLayout(item)}><span className="drag"><GripVertical size={15} /></span><strong>{group.title}</strong><span>拖动到字段前方，决定其覆盖范围</span></div>;
              }
              const field = resolvedTemplateOutputFields.find((fieldItem) => fieldItem.key === item);
              if (!field) return null;
              return <div className={`output-field confirmed-output-field ${draggedKey === item ? "is-dragging" : ""}`} key={item} draggable onDragStart={() => setDraggedKey(item)} onDragOver={(event) => event.preventDefault()} onDrop={() => reorderLayout(item)}>
                <span className="drag"><GripVertical size={16} /></span><code>{field.label}</code><span>输出模板 · {field.name} · {field.type}</span>
              </div>;
            })}
          </div> : resolvedTemplateOutputFields.length ? <div className="confirmed-output-list template-output-list">
            {resolvedTemplateOutputFields.map((field) => <label className={`output-field ${selectedFields.has(field.key) ? "output-field-selected" : ""}`} key={field.key}>
              <input type="checkbox" checked={selectedFields.has(field.key)} onChange={() => toggleField(field.key)} />
              <span className="drag">⠿</span><code>{field.label}</code><span>输出模板 · {field.name} · {field.type}</span>
            </label>)}
          </div> : <div className="output-empty-state">尚未导入输出模板。请先点击页面顶部“导入输出模板”，导入后这里只显示模板中的列。</div>}
          {!fieldsConfirmed && <div className="custom-output-section">
            <div className="custom-output-heading"><div><h3>自定义输出字段</h3><p>这里只定义字段名称和字段类型，计算逻辑请到“核算逻辑配置”页面描述。</p></div></div>
            <div className="custom-output-form"><label><span>字段名</span><input value={customName} onChange={(event) => setCustomName(event.target.value)} placeholder="例如 final_payable" /></label><label><span>字段类型</span><select value={customType} onChange={(event) => setCustomType(event.target.value)}><option value="TEXT">TEXT · 文本</option><option value="INTEGER">INTEGER · 整数</option><option value="REAL">REAL · 数值</option><option value="NUMERIC">NUMERIC · 精确数值</option></select></label><button className="button secondary compact" onClick={addCustomOutput}><Plus size={14} />增加字段</button></div>
            {customOutputs.map((item) => <div className="custom-output-item" key={item.name}><div><strong>{item.name}</strong><span>{item.type} · 计算逻辑：{item.logicName}</span></div><em>{item.status}</em></div>)}
          </div>}
          {headerDialogOpen && <div className="field-edit-backdrop"><section className="field-edit-dialog header-group-dialog" role="dialog" aria-modal="true" aria-labelledby="header-group-title"><div className="dialog-heading"><div><h2 id="header-group-title">插入大标题</h2><p>只需命名。插入后通过拖动大标题和字段，确定它在 Excel 中覆盖的连续字段范围。</p></div><button className="icon-button" aria-label="关闭插入大标题窗口" onClick={() => setHeaderDialogOpen(false)}><X size={17} /></button></div><label className="edit-field"><span>大标题名称</span><input value={headerTitle} onChange={(event) => setHeaderTitle(event.target.value)} placeholder="例如：员工基础信息" /></label><div className="dialog-actions"><button className="button secondary" onClick={() => setHeaderDialogOpen(false)}>取消</button><button className="button primary" onClick={addHeaderGroup}><Plus size={15} />插入大标题</button></div></section></div>}
          {saveRecordOpen && <div className="field-edit-backdrop"><section className="field-edit-dialog confirmation-dialog" role="dialog" aria-modal="true" aria-labelledby="output-save-record-title"><div className="dialog-heading"><div><h2 id="output-save-record-title">输出方案保存记录</h2><p>当前方案已经定稿，数据库字段顺序和 Excel 大标题布局均已保存。</p></div><button className="icon-button" aria-label="关闭保存记录" onClick={() => setSaveRecordOpen(false)}><X size={17} /></button></div><div className="confirmation-record import-record"><div><span>保存状态</span><strong>已保存</strong></div><div><span>保存时间</span><strong>{savedAt}</strong></div><div><span>输出字段</span><strong>{selectedFields.size} 个</strong></div><div><span>大标题</span><strong>{headerGroups.length} 个</strong></div><div><span>数据库结构版本</span><strong>已生成</strong></div><div><span>Excel 布局</span><strong>导出时应用</strong></div></div><div className="dialog-actions"><button className="button secondary" onClick={() => { setOutputSaved(false); setSaveRecordOpen(false); onNotify("已进入重新配置状态"); }}>重新配置输出方案</button><button className="button primary" onClick={() => setSaveRecordOpen(false)}>关闭</button></div></section></div>}
          {templateDialogOpen && <div className="field-edit-backdrop"><section className="field-edit-dialog output-template-dialog" role="dialog" aria-modal="true" aria-labelledby="output-template-title"><div className="dialog-heading"><div><h2 id="output-template-title">导入输出模板：{templateFile?.name}</h2><p>模板列已读取。这里仅决定哪些模板列作为输出列，不会自动关联数据页字段。</p></div><button className="icon-button" aria-label="关闭输出模板窗口" onClick={() => setTemplateDialogOpen(false)}><X size={17} /></button></div>{templateSheets.length > 1 && <label className="edit-field"><span>选择 Sheet</span><select value={templateSheet} onChange={(event) => { setTemplateSheet(event.target.value); readOutputTemplate(templateFile, event.target.value); }}>{templateSheets.map((sheet) => <option key={sheet} value={sheet}>{sheet}</option>)}</select></label>}<div className="template-column-list"><div className="template-column-head"><span>模板列</span><span>输出列名</span><span>使用</span></div>{templateColumns.map((column) => <div className="template-column-row" key={`${column.name}-${column.index}`}><code>{column.name}</code><strong>{column.name}</strong><input type="checkbox" checked={column.selected} onChange={(event) => setTemplateColumns((items) => items.map((item) => item.index === column.index ? { ...item, selected: event.target.checked } : item))} /></div>)}</div><div className="dialog-actions"><button className="button secondary" onClick={() => setTemplateDialogOpen(false)}>取消</button><button className="button primary" onClick={applyOutputTemplate}>应用模板并继续配置</button></div></section></div>}
        </section>
        <OutputSchemaTree
          fieldsConfirmed={fieldsConfirmed}
          selectedFields={selectedFields}
          outputOrder={outputOrder}
          layoutOrder={layoutOrder}
          templateOutputFields={resolvedTemplateOutputFields}
          headerGroups={headerGroups}
          customOutputs={customOutputs}
        />
      </div>
      <OperationLogPanel
        title="输出操作日志"
        description="记录输出模板解析、字段确认和 SQLite 结果表结构更新的状态；不展示模板中的业务数据。"
        entries={outputLogs}
        onClear={() => setOutputLogs([])}
      />
    </section>
  );
}

const createDefaultOutputFieldRule = (fieldName) => ({
  field_name: fieldName,
  mode: "source",
  source_ref: "",
  fixed_value: "",
  description: "",
  generated_code: "",
  status: "待配置",
});

const normalizeOutputFieldRuleDraft = (fieldName, currentRule = {}) => {
  const rule = {
    ...createDefaultOutputFieldRule(fieldName),
    ...currentRule,
    field_name: fieldName,
  };
  const hasSource = Boolean(String(rule.source_ref || "").trim());
  const hasFixedValue = String(rule.fixed_value ?? "").trim() !== "";
  const hasFormulaDescription = Boolean(String(rule.description || "").trim());

  if (
    (rule.mode === "source" && !hasSource)
    || (rule.mode === "fixed" && !hasFixedValue)
    || (rule.mode === "formula" && !hasFormulaDescription)
  ) {
    return { ...rule, status: "待配置" };
  }
  return rule;
};

function OutputFieldRulesPage({ onNotify }) {
  return <section className="page-frame">
    <PageHeading
      title="输出字段配置"
      description="为已确认的输出模板逐项设置数据来源、固定值或计算逻辑；字段规则独立保存，供核算执行时读取。"
    />
    <OutputFieldRulesPanel onNotify={onNotify} />
  </section>;
}

function OutputFieldRulesPanel({ onNotify }) {
  const [outputTemplateFields, setOutputTemplateFields] = useState([]);
  const [inputFieldOptions, setInputFieldOptions] = useState([]);
  const [temporaryFields, setTemporaryFields] = useState([]);
  const [outputFieldRules, setOutputFieldRules] = useState({});
  const [expandedOutputFieldNames, setExpandedOutputFieldNames] = useState(() => new Set());
  const [outputRulesSaving, setOutputRulesSaving] = useState(false);
  const [savingOutputFieldName, setSavingOutputFieldName] = useState("");

  useEffect(() => {
    let active = true;
    const readOptional = async (url, fallback) => {
      try {
        const response = await localApiFetch(url);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return await response.json();
      } catch {
        return fallback;
      }
    };
    localApiFetch("http://127.0.0.1:8787/api/output/schema").then(async (schemaResponse) => {
      if (!schemaResponse.ok) throw new Error("输出模板读取失败");
      const schema = await schemaResponse.json();
      const [savedRules, inputs, temporary] = await Promise.all([
        readOptional("http://127.0.0.1:8787/api/output/field-rules", { items: [] }),
        readOptional("http://127.0.0.1:8787/api/calculation/input-schema", { items: [] }),
        readOptional("http://127.0.0.1:8787/api/calculation/temporary-fields", { items: [] }),
      ]);
      if (!active) return;
      const fields = schema.fields || [];
      const saved = Object.fromEntries((savedRules.items || []).map((item) => [item.field_name, item]));
      setOutputTemplateFields(fields);
      setInputFieldOptions(inputs.items || []);
      setTemporaryFields(temporary.items || []);
      setOutputFieldRules(Object.fromEntries(fields.map((field) => [field.name, saved[field.name] || createDefaultOutputFieldRule(field.name)])));
    }).catch((error) => onNotify(`无法加载输出字段配置：${error.message}`));
    return () => { active = false; };
  }, []);

  const inputChoices = inputFieldOptions.length ? inputFieldOptions : dataTables.flatMap((table) => (tableMappings[table.technical] || []).map((field) => ({
    table_name: table.technical,
    table_label: table.name,
    field_name: field.db,
    field_label: field.excel,
    sqlite_type: field.dbType,
  })));
  const sourceFieldChoices = [
    ...inputChoices,
    ...temporaryFields.map((field) => ({ table_name: "temp", table_label: "临时计算字段", field_name: field.name, field_label: field.display_name || field.name, sqlite_type: "REAL" })),
    ...outputTemplateFields.map((field) => ({ table_name: "output", table_label: "输出模板", field_name: field.name, field_label: field.display_name || field.name, sqlite_type: field.sqlite_type })),
  ];
  const referenceCompletionOptions = sourceFieldChoices.map((field) => ({ token: `@${field.table_name}.${field.field_name}`, label: `${field.table_label} · ${field.field_label}`, technical: `${field.table_name}.${field.field_name}` }));
  const buildPayload = (rules) => outputTemplateFields.map((field) => normalizeOutputFieldRuleDraft(field.name, rules[field.name]));
  const updateRule = (fieldName, changes) => setOutputFieldRules((items) => ({ ...items, [fieldName]: { ...createDefaultOutputFieldRule(fieldName), ...(items[fieldName] || {}), ...changes, ...(changes.description !== undefined ? { generated_code: "", status: "待解析" } : {}) } }));
  const persistRules = async (rules, fieldName = "") => {
    const dependencyIssues = getOutputDependencyIssues(outputTemplateFields, rules);
    if (dependencyIssues.length) { onNotify("输出字段来源存在循环或无效引用，请先处理后再保存"); return false; }
    if (fieldName) setSavingOutputFieldName(fieldName); else setOutputRulesSaving(true);
    try {
      const response = await localApiFetch("http://127.0.0.1:8787/api/output/field-rules", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ rules: buildPayload(rules) }) });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "保存失败");
      setOutputFieldRules(Object.fromEntries((payload.items || []).map((item) => [item.field_name, item])));
      if (fieldName) setExpandedOutputFieldNames((names) => { const next = new Set(names); next.delete(fieldName); return next; });
      onNotify(fieldName ? `“${fieldName}”的输出字段配置已保存` : "输出字段来源与计算逻辑已保存");
      return true;
    } catch (error) { onNotify(`输出字段配置保存失败：${error.message}`); return false; } finally { setSavingOutputFieldName(""); setOutputRulesSaving(false); }
  };
  const completeRule = (field) => {
    const rule = { ...createDefaultOutputFieldRule(field.name), ...(outputFieldRules[field.name] || {}) };
    if (rule.mode === "source" && !rule.source_ref) { onNotify(`请为“${field.display_name || field.name}”选择数据来源`); return; }
    if (rule.mode === "fixed" && String(rule.fixed_value ?? "").trim() === "") { onNotify(`请为“${field.display_name || field.name}”填写固定值`); return; }
    if (rule.mode === "formula" && !rule.description?.trim()) { onNotify(`请为“${field.display_name || field.name}”填写自然语言计算逻辑`); return; }
    persistRules({ ...outputFieldRules, [field.name]: { ...rule, status: rule.mode === "formula" ? (rule.generated_code ? "已解析" : "待统一生成") : "已配置" } }, field.name);
  };

  return <section className="logic-section output-field-rules-section">
    <div className="logic-section-heading">
      <div><h4>输出字段取值配置</h4><p>逐项决定结果模板字段的来源：可直接引用数据页输入子表的“表.字段”，也可设定固定值或编写计算逻辑。</p></div>
      <button className="button primary compact" disabled={outputRulesSaving || Boolean(savingOutputFieldName) || !outputTemplateFields.length} onClick={() => persistRules(outputFieldRules)}><Check size={14} />{outputRulesSaving ? "保存中…" : "保存规则"}</button>
    </div>
    {!outputTemplateFields.length && <div className="run-logic-empty">尚未读取已确认的输出模板。请先导入并确认输出模板。</div>}
    {outputTemplateFields.map((field) => {
      const rule = outputFieldRules[field.name] || createDefaultOutputFieldRule(field.name);
      const expanded = expandedOutputFieldNames.has(field.name);
      const selectedSource = sourceFieldChoices.find((item) => `${item.table_name}.${item.field_name}` === rule.source_ref);
      return <article className={`logic-rule-card output-field-rule-card ${expanded ? "is-expanded" : "is-collapsed"}`} key={field.name}>
        <button type="button" className="output-rule-summary-button" onClick={() => setExpandedOutputFieldNames((names) => { const next = new Set(names); if (next.has(field.name)) next.delete(field.name); else next.add(field.name); return next; })}>
          <span><b>{field.display_name || field.name}</b><small>{field.name} · {field.sqlite_type}</small>{rule.mode === "source" && selectedSource && <small className="output-rule-summary-source">来源：{selectedSource.table_label} · {selectedSource.field_label}（{selectedSource.table_name}.{selectedSource.field_name}）</small>}</span><span><em>{rule.status || "待配置"}</em><ChevronRight size={16} /></span>
        </button>
        {expanded && <div className="output-rule-card-body"><div className="output-rule-row"><div className="output-rule-field"><span>输出字段</span><strong>{field.display_name || field.name}</strong><small>{field.name} · {field.sqlite_type}</small></div><label className="output-rule-mode"><span>取值方式</span><select value={rule.mode} onChange={(event) => updateRule(field.name, { mode: event.target.value, status: "待配置" })}><option value="source">直接引用输入字段</option><option value="formula">计算逻辑</option><option value="fixed">固定值</option></select></label><em className="output-rule-status">{rule.status || "待配置"}</em></div>
          {rule.mode === "source" && <label className="output-rule-source"><span>数据来源</span><InputFieldPicker value={rule.source_ref || ""} options={sourceFieldChoices.filter((item) => !(item.table_name === "output" && item.field_name === field.name))} onChange={(value) => updateRule(field.name, { source_ref: value, status: "待配置" })} /></label>}
          {rule.mode === "fixed" && <label className="output-rule-source"><span>固定值</span><input value={rule.fixed_value || ""} onChange={(event) => updateRule(field.name, { fixed_value: event.target.value, status: "待配置" })} placeholder="例如 0、正式、月薪" /></label>}
          {rule.mode === "formula" && <div className="output-rule-formula"><LogicDescriptionInput value={rule.description || ""} onChange={(description) => updateRule(field.name, { description })} placeholder={`描述如何计算“${field.display_name || field.name}”；输入 @ 可选择字段，例如 @output.gross_pay_before_tax。`} compact referenceOptions={referenceCompletionOptions} /><small className="output-reference-hint">输出模板字段请使用 @output.字段名 引用。</small><GeneratedCodePreview rule={{ generatedCode: rule.generated_code, codeSummary: rule.codeSummary, reviewNotes: rule.reviewNotes }} /></div>}
          <div className="output-rule-complete-action"><button className="button primary compact" disabled={outputRulesSaving || Boolean(savingOutputFieldName)} onClick={() => completeRule(field)}><Check size={14} />{savingOutputFieldName === field.name ? "保存中…" : "完成"}</button></div>
        </div>}
      </article>;
    })}
  </section>;
}

function OutputSchemaTree({ fieldsConfirmed, selectedFields, outputOrder, layoutOrder, templateOutputFields, headerGroups, customOutputs }) {
  const fieldMap = new Map(templateOutputFields.map((field) => [field.key, { ...field, source: "输出模板" }]));
  const activeOrder = (fieldsConfirmed ? layoutOrder : outputOrder.filter((key) => selectedFields.has(key)))
    .filter((key) => key.startsWith("header:") || fieldMap.has(key));
  const customItems = customOutputs.map((item) => ({
    name: item.name,
    type: item.type,
    source: "自定义输出字段",
  }));
  return <aside className="panel output-schema-tree-panel">
    <div className="output-schema-tree-heading">
      <div><h2>最终表结构</h2><p>{fieldsConfirmed ? "已确认输出顺序，与左侧最终方案同步。" : "跟随左侧字段选择实时预览。"}</p></div>
      <Status status={fieldsConfirmed ? "已确认" : "待确认"} />
    </div>
    <div className="output-schema-tree">
      <div className="tree-root"><span className="tree-marker">▾</span><div><strong>本地核算结果</strong><code>local_calculation_result</code></div></div>
      <div className="tree-children">
        {!activeOrder.length && !customItems.length && <div className="tree-empty-state">导入输出模板后显示模板列</div>}
        {activeOrder.map((item) => {
          if (item.startsWith("header:")) {
            const group = headerGroups.find((header) => `header:${header.id}` === item);
            return group ? <div className="tree-header-node" key={item}><span className="tree-branch">├─</span><strong>{group.title}</strong></div> : null;
          }
          const field = fieldMap.get(item);
          return <div className="tree-field-node" key={item}><span className="tree-branch">├─</span><span className="tree-leaf">•</span><div><code>{field.label}</code><small>{field.source} · {field.name} · {field.type}</small></div></div>;
        })}
        {customItems.map((item) => <div className="tree-field-node" key={`custom:${item.name}`}><span className="tree-branch">├─</span><span className="tree-leaf">•</span><div><code>{item.name}</code><small>{item.source} · {item.type}</small></div></div>)}
      </div>
    </div>
  </aside>;
}
function InputFieldPicker({ value, options, onChange }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const pickerRef = useRef(null);
  const searchInputRef = useRef(null);
  const selected = options.find((item) => `${item.table_name}.${item.field_name}` === value);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setOpen(false);
  }, [value]);

  const normalizedQuery = query.trim().toLocaleLowerCase();
  const filteredOptions = normalizedQuery
    ? options.filter((item) => [
        item.table_label,
        item.table_name,
        item.field_label,
        item.field_name,
        `${item.table_label} ${item.field_label}`,
        `${item.table_name}.${item.field_name}`,
      ].filter(Boolean).join(" ").toLocaleLowerCase().includes(normalizedQuery))
    : options;

  useEffect(() => {
    if (!open) return undefined;

    const handlePointerDown = (event) => {
      if (!pickerRef.current?.contains(event.target)) {
        setQuery("");
        setOpen(false);
      }
    };

    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const frame = requestAnimationFrame(() => searchInputRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [open]);

  const closePicker = () => {
    setQuery("");
    setOpen(false);
  };

  const selectField = (nextValue) => {
    closePicker();
    onChange(nextValue);
  };

  const handleSearchKeyDown = (event) => {
    if (event.key === "Escape") {
      closePicker();
      return;
    }
    if (event.key === "Enter" && filteredOptions.length > 0) {
      event.preventDefault();
      const first = filteredOptions[0];
      selectField(`${first.table_name}.${first.field_name}`);
    }
  };

  return <div ref={pickerRef} className="field-picker">
    {open ? (
      <input
        ref={searchInputRef}
        type="search"
        className="field-picker-trigger field-picker-search-trigger"
        value={query}
        placeholder={selected ? "输入关键词替换当前字段" : "输入表名、字段名或数据库字段名"}
        aria-label="搜索数据页字段"
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={handleSearchKeyDown}
      />
    ) : (
      <button type="button" className="field-picker-trigger" onClick={() => setOpen(true)}>
        <span>{selected ? `${selected.table_label} · ${selected.field_label}（${selected.table_name}.${selected.field_name}）` : value ? value : "请选择 数据页.表.字段"}</span><ChevronDown size={15} />
      </button>
    )}
    {open && <div className="field-picker-menu" role="listbox">
      <button type="button" className="field-picker-option placeholder" onMouseDown={(event) => event.preventDefault()} onClick={(event) => { event.preventDefault(); event.stopPropagation(); selectField(""); }}>请选择 数据页.表.字段</button>
      {filteredOptions.map((item) => {
        const optionValue = `${item.table_name}.${item.field_name}`;
        return <button type="button" role="option" aria-selected={optionValue === value} className={`field-picker-option ${optionValue === value ? "is-selected" : ""}`} key={optionValue} onMouseDown={(event) => event.preventDefault()} onClick={(event) => { event.preventDefault(); event.stopPropagation(); selectField(optionValue); }}>
          {item.table_label} · {item.field_label}（{optionValue}）
        </button>;
      })}
      {filteredOptions.length === 0 && <div className="field-picker-empty">没有匹配的字段，请换一个关键词</div>}
    </div>}
  </div>;
}

function RunPage({ onNotify, customOutputs, setCustomOutputs, logicValidated, setLogicValidated }) {
  const [statutoryRules, setStatutoryRules] = useState([]);
  const [runLogs, setRunLogs] = useState([]);
  const appendRunLog = (level, message, detail = "") => setRunLogs((logs) => [{ id: `run-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, level, message, detail, createdAt: new Date().toLocaleString("zh-CN", { hour12: false }) }, ...logs].slice(0, 100));
  const [statutoryConfigOpen, setStatutoryConfigOpen] = useState(false);
  const [globalConfigOpen, setGlobalConfigOpen] = useState(false);
  const [holidayCalendar, setHolidayCalendar] = useState(() => {
    try { return JSON.parse(localStorage.getItem("payroll-statutory-holidays") || "null") || statutoryHolidayDefaults.holidays; } catch { return statutoryHolidayDefaults.holidays; }
  });
  const [holidayJsonText, setHolidayJsonText] = useState(() => localStorage.getItem("payroll-statutory-holidays") || JSON.stringify(statutoryHolidayDefaults.holidays, null, 2));
  const [sickLeavePolicy, setSickLeavePolicy] = useState(() => { try { return JSON.parse(localStorage.getItem("payroll-sick-leave-policy") || "null") || sickLeaveDefaults.rules; } catch { return sickLeaveDefaults.rules; } });
  const [sickLeavePolicyJson, setSickLeavePolicyJson] = useState(() => localStorage.getItem("payroll-sick-leave-policy") || JSON.stringify(sickLeaveDefaults.rules, null, 2));
  const [sickLeaveCapJson, setSickLeaveCapJson] = useState(() => localStorage.getItem("payroll-sick-leave-cap") || JSON.stringify(sickLeaveDefaults.high_income_cap, null, 2));
  const [sickLeaveHireDateField, setSickLeaveHireDateField] = useState(() => localStorage.getItem("payroll-sick-leave-hire-date-field") || sickLeaveDefaults.hire_date_field);
  const [sickLeaveBaseField, setSickLeaveBaseField] = useState(() => localStorage.getItem("payroll-sick-leave-base-field") || sickLeaveDefaults.base_field);
  const [minimumWageRule, setMinimumWageRule] = useState(() => { try { return JSON.parse(localStorage.getItem("payroll-minimum-wage-rule") || "null") || minimumWageDefaults.rule; } catch { return minimumWageDefaults.rule; } });
  const [minimumWageJson, setMinimumWageJson] = useState(() => localStorage.getItem("payroll-minimum-wage-rule") || JSON.stringify(minimumWageDefaults.rule, null, 2));
  const [netIncomeField, setNetIncomeField] = useState(() => localStorage.getItem("payroll-net-income-field") || minimumWageDefaults.net_income_field);
  const [absenceDaysField, setAbsenceDaysField] = useState(() => localStorage.getItem("payroll-absence-days-field") || minimumWageDefaults.absence_days_field);
  const [standardWorkDaysField, setStandardWorkDaysField] = useState(() => localStorage.getItem("payroll-standard-work-days-field") || minimumWageDefaults.standard_work_days_field);
  const [shiftField, setShiftField] = useState(() => localStorage.getItem("payroll-shift-field") || attendanceScheduleDefaults.shift_field);
  const [attendanceMode, setAttendanceMode] = useState(() => localStorage.getItem("payroll-attendance-mode") || attendanceScheduleDefaults.attendance_mode);
  const defaultAttendanceSchedule = attendanceScheduleDefaults.months;
  const [attendanceSchedule, setAttendanceSchedule] = useState(() => { try { return JSON.parse(localStorage.getItem("payroll-attendance-schedule") || "null") || defaultAttendanceSchedule; } catch { return defaultAttendanceSchedule; } });
  const [attendanceScheduleJson, setAttendanceScheduleJson] = useState(() => localStorage.getItem("payroll-attendance-schedule") || JSON.stringify(attendanceScheduleDefaults.months, null, 2));
  useEffect(() => { if (!localStorage.getItem("payroll-statutory-holidays")) setHolidayJsonText(JSON.stringify(holidayCalendar, null, 2)); }, [holidayCalendar]);
  useEffect(() => { if (!localStorage.getItem("payroll-sick-leave-policy")) setSickLeavePolicyJson(JSON.stringify(sickLeavePolicy, null, 2)); }, [sickLeavePolicy]);
  useEffect(() => { if (!localStorage.getItem("payroll-minimum-wage-rule")) setMinimumWageJson(JSON.stringify(minimumWageRule, null, 2)); }, [minimumWageRule]);
  useEffect(() => { if (!localStorage.getItem("payroll-attendance-schedule")) setAttendanceScheduleJson(JSON.stringify(attendanceSchedule, null, 2)); }, [attendanceSchedule]);
  const [globalRules, setGlobalRules] = useState([]);
  const globalLogicLoaded = useRef(false);
  useEffect(() => {
    localApiFetch("http://127.0.0.1:8787/api/calculation/global-logic")
      .then((response) => response.ok ? response.json() : Promise.reject(new Error("无法读取组织全局计算逻辑")))
      .then((payload) => setGlobalRules(Array.isArray(payload.items) ? payload.items : []))
      .catch((error) => { appendRunLog("error", "无法读取组织全局计算逻辑", error.message); onNotify(`无法读取组织全局计算逻辑：${error.message}`); })
      .finally(() => { globalLogicLoaded.current = true; });
  }, []);
  useEffect(() => {
    if (!globalLogicLoaded.current) return;
    localApiFetch("http://127.0.0.1:8787/api/calculation/global-logic", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ rules: globalRules }) })
      .catch((error) => { appendRunLog("error", "组织全局计算逻辑保存失败", error.message); onNotify(`组织全局计算逻辑保存失败：${error.message}`); });
  }, [globalRules]);
  const [tableRules, setTableRules] = useState([]);
  const [validationIssues, setValidationIssues] = useState([]);
  const [validatedModelVersion, setValidatedModelVersion] = useState("");
  useEffect(() => { if (!logicValidated) setValidatedModelVersion(""); }, [logicValidated]);
  const [calculationCompleted, setCalculationCompleted] = useState(false);
  const [calculationRunning, setCalculationRunning] = useState(false);
  const [outputTemplateFields, setOutputTemplateFields] = useState([]);
  const [inputFieldOptions, setInputFieldOptions] = useState([]);
  const [outputFieldRules, setOutputFieldRules] = useState({});
  const [temporaryFields, setTemporaryFields] = useState([]);
  const [temporaryFieldsSaving, setTemporaryFieldsSaving] = useState(false);
  const [expandedTemporaryFieldNames, setExpandedTemporaryFieldNames] = useState(() => new Set());
  const [batchGenerating, setBatchGenerating] = useState(false);
  const [batchProgress, setBatchProgress] = useState({ current: 0, total: 0 });
  const [generationFeedback, setGenerationFeedback] = useState(null);
  const logicPackageInputRef = useRef(null);
  const [packageDialog, setPackageDialog] = useState(null);
  const [repairRequest, setRepairRequest] = useState("");
  const [repairAnswer, setRepairAnswer] = useState("");
  const [repairLoading, setRepairLoading] = useState(false);
  const lastRunError = runLogs.find((entry) => entry.level === "error");
  const participatingFieldCount = inputFieldOptions.length;
  const participatingTableCount = new Set(inputFieldOptions.map((field) => field.table_name)).size;
  const inputFieldChoices = inputFieldOptions.length ? inputFieldOptions : dataTables.flatMap((table) => (tableMappings[table.technical] || []).map((field) => ({
    table_name: table.technical,
    table_label: table.name,
    field_name: field.db,
    field_label: field.excel,
    sqlite_type: field.dbType,
  })));
  const inputTableOptionsRaw = Array.from(inputFieldChoices.reduce((tablesByName, field) => {
    const current = tablesByName.get(field.table_name) || { technical: field.table_name, name: field.table_label || field.table_name, fields: [] };
    current.fields.push({ name: field.field_name, label: field.field_label || field.field_name });
    tablesByName.set(field.table_name, current);
    return tablesByName;
  }, new Map()).values());
  const inputTableNameCounts = inputTableOptionsRaw.reduce((counts, table) => counts.set(table.name, (counts.get(table.name) || 0) + 1), new Map());
  const inputTableOptions = inputTableOptionsRaw.map((table) => ({ ...table, name: inputTableNameCounts.get(table.name) > 1 ? `${table.name}（${table.technical}）` : table.name }));
  const activeRuleCount = (rules) => rules.filter((rule) => rule.status === "已解析" && String(rule.generatedCode || "").trim()).length;
  const generatedLogicCount = [
    ...statutoryRules,
    ...globalRules,
    ...tableRules,
    ...customOutputs,
    ...temporaryFields.map((field) => ({ generatedCode: field.generated_code, status: field.status })),
    ...outputTemplateFields.map((field) => ({ generatedCode: outputFieldRules[field.name]?.generated_code, status: outputFieldRules[field.name]?.status })),
  ].filter((rule) => String(rule.generatedCode || "").trim() && rule.status === "已解析").length;
  const codeTargetCount = [
    ...statutoryRules,
    ...globalRules,
    ...tableRules,
    ...customOutputs,
    ...temporaryFields.filter((field) => field.description?.trim()),
    ...outputTemplateFields.filter((field) => outputFieldRules[field.name]?.mode === "formula" && outputFieldRules[field.name]?.description?.trim()),
  ].length;
  const pythonCodeGenerated = codeTargetCount > 0 && generatedLogicCount === codeTargetCount;
  const completedTemporaryFieldCount = temporaryFields.filter((field) => field.status === "已解析" && String(field.generated_code || "").trim()).length;
  const configuredOutputFieldCount = outputTemplateFields.filter((field) => {
    const rule = normalizeOutputFieldRuleDraft(field.name, outputFieldRules[field.name]);
    if (rule.mode === "source") return Boolean(String(rule.source_ref || "").trim());
    if (rule.mode === "fixed") return String(rule.fixed_value ?? "").trim() !== "";
    return rule.mode === "formula" && rule.status === "已解析" && Boolean(String(rule.generated_code || "").trim());
  }).length;
  const calculationConfigurationStatuses = [
    { key: "statutory", label: "法定算法逻辑", value: `${activeRuleCount(statutoryRules)} 条生效`, complete: statutoryRules.length > 0 && activeRuleCount(statutoryRules) === statutoryRules.length, empty: statutoryRules.length === 0 },
    { key: "temporary", label: "临时字段", value: `${temporaryFields.length} 个`, detail: temporaryFields.length ? `${completedTemporaryFieldCount}/${temporaryFields.length} 已完成` : "未设置", complete: temporaryFields.length > 0 && completedTemporaryFieldCount === temporaryFields.length, empty: temporaryFields.length === 0 },
    { key: "global", label: "全局计算逻辑", value: `${activeRuleCount(globalRules)} 条生效`, complete: globalRules.length > 0 && activeRuleCount(globalRules) === globalRules.length, empty: globalRules.length === 0 },
    { key: "table", label: "单表计算逻辑", value: `${activeRuleCount(tableRules)} 条生效`, complete: tableRules.length > 0 && activeRuleCount(tableRules) === tableRules.length, empty: tableRules.length === 0 },
    { key: "output", label: "输出字段", value: `${configuredOutputFieldCount}/${outputTemplateFields.length}`, detail: "已配置 / 总数", complete: outputTemplateFields.length > 0 && configuredOutputFieldCount === outputTemplateFields.length, empty: outputTemplateFields.length === 0 },
    { key: "python", label: "Python 代码", value: codeTargetCount ? `${generatedLogicCount}/${codeTargetCount}` : "无需生成", detail: "已生成 / 待生成", complete: codeTargetCount === 0 || pythonCodeGenerated, empty: codeTargetCount === 0 },
    { key: "validation", label: "逻辑校验", value: logicValidated ? "已通过" : validationIssues.length ? `${validationIssues.length} 个问题` : "待校验", detail: "核算前检查", complete: logicValidated, empty: !logicValidated && validationIssues.length === 0 },
  ];
  const sourceFieldChoices = [...inputFieldChoices, ...temporaryFields.map((field) => ({ table_name: "temp", table_label: "临时计算字段", field_name: field.name, field_label: field.display_name || field.name, sqlite_type: "REAL" })), ...outputTemplateFields.map((field) => ({
    table_name: "output",
    table_label: "输出模板",
    field_name: field.name,
    field_label: field.display_name || field.name,
    sqlite_type: field.sqlite_type,
  }))];
  const availableFields = [...inputFieldChoices.map((field) => `${field.table_name}.${field.field_name}`), ...temporaryFields.map((field) => `temp.${field.name}`), ...outputTemplateFields.map((field) => `output.${field.name}`)];
  const referenceCompletionOptions = [...inputFieldChoices.map((field) => ({ token: `@${field.table_name}.${field.field_name}`, label: `数据页 · ${field.table_label} · ${field.field_label}`, technical: `${field.table_name}.${field.field_name}` })), ...temporaryFields.map((field) => ({ token: `@temp.${field.name}`, label: `临时字段 · ${field.display_name || field.name}`, technical: `temp.${field.name}` })), ...outputTemplateFields.map((field) => ({ token: `@output.${field.name}`, label: `输出模板 · ${field.display_name || field.name}`, technical: `output.${field.name}` }))];

  useEffect(() => {
    Promise.all([
      localApiFetch("http://127.0.0.1:8787/api/output/schema").then((response) => response.ok ? response.json() : Promise.reject(new Error("无法读取输出模板"))),
      localApiFetch("http://127.0.0.1:8787/api/output/field-rules").then((response) => response.ok ? response.json() : Promise.reject(new Error("无法读取输出字段配置"))),
      localApiFetch("http://127.0.0.1:8787/api/calculation/input-schema").then((response) => response.ok ? response.json() : Promise.reject(new Error("无法读取输入子表"))),
      localApiFetch("http://127.0.0.1:8787/api/calculation/temporary-fields").then((response) => response.ok ? response.json() : Promise.reject(new Error("无法读取临时字段"))),
    ]).then(([schema, savedRules, inputs, temporary]) => {
      const fields = schema.fields || [];
      const saved = Object.fromEntries((savedRules.items || []).map((item) => [item.field_name, item]));
      setOutputTemplateFields(fields);
      setInputFieldOptions(inputs.items || []);
      setTemporaryFields(temporary.items || []);
      setOutputFieldRules(Object.fromEntries(fields.map((field) => [field.name, saved[field.name] || { field_name: field.name, mode: "source", source_ref: "", fixed_value: "", description: "", generated_code: "", status: "待配置" }])));
    }).catch((error) => { appendRunLog("error", "无法加载核算配置", error.message); onNotify(`无法加载核算配置：${error.message}`); });
  }, []);

  const saveTemporaryFields = async (items = temporaryFields) => {
    const issues = getTemporaryDependencyIssues(items);
    if (issues.length) { setValidationIssues(issues); onNotify("临时字段存在循环或无效引用，请先处理后再保存"); return false; }
    setTemporaryFieldsSaving(true);
    try { const response = await localApiFetch("http://127.0.0.1:8787/api/calculation/temporary-fields", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ items }) }); const payload = await response.json(); if (!response.ok) throw new Error(payload.error || "保存失败"); setTemporaryFields(payload.items || []); onNotify("临时计算字段已保存"); return true; } catch (error) { onNotify(`临时计算字段保存失败：${error.message}`); return false; } finally { setTemporaryFieldsSaving(false); }
  };
  const addTemporaryField = () => { const name = `temp_${Date.now().toString().slice(-6)}`; setLogicValidated(false); setTemporaryFields((items) => [...items, { name, display_name: "未命名临时字段", description: "", generated_code: "", status: "待配置", priority: 100 }]); };
  const updateTemporaryField = (name, changes) => { setLogicValidated(false); setCalculationCompleted(false); setValidationIssues([]); setTemporaryFields((items) => items.map((item) => item.name === name ? { ...item, ...changes, ...(changes.description !== undefined || changes.name !== undefined ? { generated_code: "", status: "待解析" } : {}) } : item)); };
  const removeTemporaryField = (name) => { setLogicValidated(false); setTemporaryFields((items) => items.filter((item) => item.name !== name)); };
  const completeTemporaryField = async (field) => {
    if (!field.name.trim() || !/^[a-z][a-z0-9_]{0,62}$/.test(field.name)) { onNotify("临时字段名必须是小写 snake_case"); return; }
    if (!field.display_name?.trim()) { onNotify("请填写临时字段显示名称"); return; }
    if (!field.description?.trim()) { onNotify(`请为“${field.display_name || field.name}”填写自然语言计算逻辑`); return; }
    const nextFields = temporaryFields.map((item) => item.name === field.name ? { ...item, status: "待统一生成" } : item);
    setTemporaryFields(nextFields);
    if (await saveTemporaryFields(nextFields)) setExpandedTemporaryFieldNames((names) => { const next = new Set(names); next.delete(field.name); return next; });
  };

const buildOutputFieldRulesPayload = (rules) => outputTemplateFields.map((field) => (
  normalizeOutputFieldRuleDraft(field.name, rules[field.name])
));

  const generateAllCalculationCode = async () => {
    const dependencyIssues = [...getOutputDependencyIssues(outputTemplateFields, outputFieldRules), ...getTemporaryDependencyIssues(temporaryFields)];
    if (dependencyIssues.length) { setValidationIssues(dependencyIssues); appendRunLog("error", "统一生成代码前校验失败", `发现 ${dependencyIssues.length} 个字段引用问题`); onNotify("输出字段引用存在问题，请先处理循环引用或不存在的字段"); return; }
    const targets = [
      ...temporaryFields.filter((field) => field.status !== "已解析" && field.description?.trim()).map((field) => ({ key: `temp:${field.name}`, name: field.display_name || field.name, scope: "temporary", description: `目标临时字段为 ${field.name}；函数必须返回 {'${field.name}': 值}。${field.description}`, temp_dependencies: getTemporaryReferences(field.description) })),
      ...outputTemplateFields.filter((field) => outputFieldRules[field.name]?.mode === "formula" && outputFieldRules[field.name]?.status === "待统一生成" && outputFieldRules[field.name]?.description?.trim()).map((field) => ({ key: `output:${field.name}`, name: field.display_name || field.name, scope: "output", description: `目标输出字段为 ${field.name}。${outputFieldRules[field.name].description}`, output_dependencies: getOutputReferences(outputFieldRules[field.name].description), temp_dependencies: getTemporaryReferences(outputFieldRules[field.name].description) })),
      ...statutoryRules.filter((rule) => rule.description?.trim()).map((rule) => ({ key: `statutory:${rule.id}`, name: rule.project, scope: "statutory", table: rule.table, description: rule.description })),
      ...globalRules.filter((rule) => rule.description?.trim()).map((rule) => ({ key: `global:${rule.id}`, name: rule.project, scope: "global", table: rule.table, description: rule.description })),
      ...tableRules.filter((rule) => rule.status === "待统一生成" && rule.description?.trim()).map((rule) => ({ key: `table:${rule.id}`, name: rule.project, scope: "table", table: rule.table, description: rule.description })),
      ...customOutputs.filter((rule) => rule.description?.trim()).map((rule) => ({ key: `custom:${rule.name}`, name: rule.logicName || rule.name, scope: "global", description: rule.description })),
    ];
    if (!targets.length) { appendRunLog("error", "未生成 Python 代码", "请先填写至少一条自然语言计算逻辑"); onNotify("请先填写至少一条自然语言计算逻辑"); return; }
    const orderedTargets = orderGenerationTargets(targets);
    const batchSize = 6;
    const batches = Array.from({ length: Math.ceil(orderedTargets.length / batchSize) }, (_, index) => orderedTargets.slice(index * batchSize, (index + 1) * batchSize));
    setBatchGenerating(true);
    setBatchProgress({ current: 0, total: batches.length });
    setGenerationFeedback(null);
    let completedBatches = 0;
    try {
      appendRunLog("info", "正在分批生成 Python 代码", `共 ${batches.length} 批，每批最多 ${batchSize} 条规则；依赖字段将优先生成`);
      const allGenerated = {};
      let previousResults = [];
      const applyGenerated = (items) => {
        const generated = Object.fromEntries(items.map((item) => [item.key, item]));
        setOutputFieldRules((rules) => Object.fromEntries(Object.entries(rules).map(([name, rule]) => {
          const result = generated[`output:${name}`];
          const codeIssues = result ? inspectGeneratedPythonCode(result.python_code, `输出字段：${name}`) : [];
          return [name, result ? { ...rule, generated_code: result.python_code, status: codeIssues.length ? "代码校验未通过" : "已解析", codeSummary: result.summary, reviewNotes: [...codeIssues, result.review_notes].filter(Boolean).join("；") } : rule];
        })));
        setTemporaryFields((fields) => fields.map((field) => { const result = generated[`temp:${field.name}`]; const codeIssues = result ? inspectGeneratedPythonCode(result.python_code, `临时字段：${field.display_name || field.name}`) : []; return result ? { ...field, generated_code: result.python_code, status: codeIssues.length ? "代码校验未通过" : "已解析", codeSummary: result.summary, reviewNotes: [...codeIssues, result.review_notes].filter(Boolean).join("；") } : field; }));
        const applyScope = (scope, setter) => setter((rules) => rules.map((rule) => {
          const result = generated[`${scope}:${rule.id}`];
          const codeIssues = result ? inspectGeneratedPythonCode(result.python_code, rule.project || rule.name || rule.id) : [];
          return result ? { ...rule, generatedCode: result.python_code, status: codeIssues.length ? "代码校验未通过" : "已解析", codeSummary: result.summary, reviewNotes: [...codeIssues, result.review_notes].filter(Boolean).join("；") } : rule;
        }));
        applyScope("statutory", setStatutoryRules); applyScope("global", setGlobalRules); applyScope("table", setTableRules);
        setCustomOutputs((rules) => rules.map((rule) => {
          const result = generated[`custom:${rule.name}`];
          const codeIssues = result ? inspectGeneratedPythonCode(result.python_code, rule.logicName || rule.name) : [];
          return result ? { ...rule, generatedCode: result.python_code, status: codeIssues.length ? "代码校验未通过" : "已解析", codeSummary: result.summary, reviewNotes: [...codeIssues, result.review_notes].filter(Boolean).join("；") } : rule;
        }));
        items.forEach((item) => { allGenerated[item.key] = item; });
      };
      for (let index = 0; index < batches.length; index += 1) {
        const batch = batches[index];
        appendRunLog("info", `正在生成第 ${index + 1}/${batches.length} 批`, `本批 ${batch.length} 条规则`);
        const response = await localApiFetch("http://127.0.0.1:8787/api/ai/calculation-logic/generate-batch", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ rules: batch, available_fields: availableFields, output_fields: outputTemplateFields.map((field) => ({ name: field.name, display_name: field.display_name || field.name, sqlite_type: field.sqlite_type })), batch_index: index + 1, batch_total: batches.length, previous_results: previousResults.slice(-12).map((item) => ({ key: item.key, summary: item.summary, review_notes: item.review_notes })) }) });
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error || `第 ${index + 1} 批生成失败`);
        const items = payload.items || [];
        if (!items.length) throw new Error(`第 ${index + 1} 批未返回可用代码`);
        applyGenerated(items);
        const outputItems = items.filter((item) => item.key.startsWith("output:"));
        const temporaryItems = items.filter((item) => item.key.startsWith("temp:"));
        if (temporaryItems.length) {
          const generatedByName = Object.fromEntries(Object.values(allGenerated).filter((item) => item.key.startsWith("temp:")).map((item) => [item.key.slice("temp:".length), item]));
          const persistedTemporary = temporaryFields.map((field) => { const generated = generatedByName[field.name]; if (!generated) return field; const codeIssues = inspectGeneratedPythonCode(generated.python_code, `临时字段：${field.display_name || field.name}`); return { ...field, generated_code: generated.python_code, status: codeIssues.length ? "代码校验未通过" : "已解析", codeSummary: generated.summary, reviewNotes: [...codeIssues, generated.review_notes].filter(Boolean).join("；") }; });
          const saveResponse = await localApiFetch("http://127.0.0.1:8787/api/calculation/temporary-fields", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ items: persistedTemporary }) }); const savePayload = await saveResponse.json(); if (!saveResponse.ok) throw new Error(savePayload.error || `第 ${index + 1} 批临时字段代码保存失败`); setTemporaryFields(savePayload.items || persistedTemporary);
        }
        if (outputItems.length) {
          const outputResults = Object.fromEntries(outputItems.map((item) => [item.key.slice("output:".length), item]));
          const persistedRules = Object.fromEntries(outputTemplateFields.map((field) => {
            const current = { ...createDefaultOutputFieldRule(field.name), ...(outputFieldRules[field.name] || {}) };
            const generated = outputResults[field.name];
            if (!generated) return [field.name, current];
            const codeIssues = inspectGeneratedPythonCode(generated.python_code, `输出字段：${field.display_name || field.name}（${field.name}）`);
            return [field.name, { ...current, generated_code: generated.python_code, status: codeIssues.length ? "代码校验未通过" : "已解析", codeSummary: generated.summary, reviewNotes: [...codeIssues, generated.review_notes].filter(Boolean).join("；") }];
          }));
          const saveResponse = await localApiFetch("http://127.0.0.1:8787/api/output/field-rules", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ rules: buildOutputFieldRulesPayload(persistedRules) }) });
          const savePayload = await saveResponse.json();
          if (!saveResponse.ok) throw new Error(savePayload.error || `第 ${index + 1} 批输出字段代码保存失败`);
        }
        previousResults = [...previousResults, ...items];
        completedBatches = index + 1;
        setBatchProgress({ current: index + 1, total: batches.length });
        appendRunLog("success", `第 ${index + 1}/${batches.length} 批生成完成`, `本批返回 ${items.length} 条待审核代码`);
      }
      appendRunLog("success", "分批生成 Python 代码完成", `已生成 ${Object.keys(allGenerated).length} 条待审核代码`);
      setGenerationFeedback({ type: "success", message: `已生成 ${Object.keys(allGenerated).length} 条代码` });
      onNotify(`已分批生成 ${Object.keys(allGenerated).length} 条待审核 Python 代码`);
    } catch (error) {
      appendRunLog("error", "分批生成 Python 代码失败", `已完成 ${completedBatches}/${batches.length} 批；${error.message}`);
      setGenerationFeedback({ type: "error", message: `生成失败，已完成 ${completedBatches}/${batches.length} 批` });
      onNotify(`分批生成失败：${error.message}`);
    } finally {
      setBatchGenerating(false);
    }
  };

  const addRule = (scope) => {
    const id = `${scope}-${Date.now()}`;
    setLogicValidated(false);
    setCalculationCompleted(false);
    setValidationIssues([]);
    if (scope === "statutory") {
      setStatutoryRules((items) => [...items, { id, project: "新的法定计算项目", priority: (items.length + 1) * 100, description: "", status: "待解析" }]);
    } else if (scope === "global") {
      setGlobalRules((items) => [...items, { id, project: "新的计算项目", priority: (items.length + 1) * 100, description: "", status: "待解析" }]);
    } else {
      if (!inputTableOptions.length) { onNotify("当前组织尚未确认可参与核算的数据表"); return; }
      setTableRules((items) => [...items, { id, table: inputTableOptions[0].technical, project: "表内特殊处理", description: "", status: "待解析" }]);
    }
  };

  const removeRule = (scope, id) => {
    setLogicValidated(false);
    setCalculationCompleted(false);
    setValidationIssues([]);
    const setter = scope === "statutory" ? setStatutoryRules : scope === "global" ? setGlobalRules : setTableRules;
    setter((items) => items.filter((item) => item.id !== id));
  };

  const updateRule = (scope, id, changes) => {
    setLogicValidated(false);
    setCalculationCompleted(false);
    setValidationIssues([]);
    const setter = scope === "statutory" ? setStatutoryRules : scope === "global" ? setGlobalRules : setTableRules;
    const isTableConfigurationChange = scope === "table" && (changes.table !== undefined || changes.project !== undefined);
    setter((items) => items.map((item) => item.id === id ? { ...item, ...changes, ...((changes.description !== undefined || isTableConfigurationChange) ? { generatedCode: "", status: "待解析" } : {}), status: (changes.description !== undefined || isTableConfigurationChange) ? "待解析" : (changes.status || item.status) } : item));
  };

  const completeTableRule = (rule) => {
    if (!rule.table) { onNotify("请选择单表计算逻辑的目标数据表"); return; }
    if (!rule.project?.trim()) { onNotify("请填写单表计算逻辑名称"); return; }
    if (!rule.description?.trim()) { onNotify(`请为“${rule.project}”填写自然语言计算逻辑`); return; }
    updateRule("table", rule.id, { status: "待统一生成" });
    onNotify(`“${rule.project}”已完成配置，请在顶部统一生成 Python 代码`);
  };

  const requestGeneratedCode = async (rule) => {
    const response = await localApiFetch("http://127.0.0.1:8787/api/ai/calculation-logic/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: rule.project || rule.logicName, description: rule.description, scope: rule.scope, table: rule.table, available_fields: availableFields }),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "AI 代码生成失败");
    return payload;
  };

  const generateRuleCode = async (scope, rule) => {
    if (!rule.description.trim()) { onNotify(`请先用自然语言描述“${rule.project}”的计算逻辑`); return; }
    try {
      const result = await requestGeneratedCode({ ...rule, scope });
      updateRule(scope, rule.id, { status: "已解析", generatedCode: result.python_code, codeSummary: result.summary, reviewNotes: result.review_notes });
      onNotify(`AI 已理解“${rule.project}”，已生成待审核的 Python 代码`);
    } catch (error) {
      onNotify(`AI 代码生成失败：${error.message}`);
    }
  };

  const saveHolidayCalendar = () => {
    try {
      const parsed = JSON.parse(holidayJsonText);
      const rows = Array.isArray(parsed) ? parsed : parsed.holidays;
      const normalized = (rows || []).map((item) => ({ year: Number(item.year), date: String(item.date || "").trim(), multiplier: Number(item.multiplier || 3) })).filter((item) => item.year && item.date && item.multiplier > 0);
      if (!normalized.length) throw new Error("至少需要一条有效的年份、日期配置");
      setHolidayCalendar(normalized); setHolidayJsonText(JSON.stringify(normalized, null, 2)); localStorage.setItem("payroll-statutory-holidays", JSON.stringify(normalized));
      appendRunLog("success", "法定节假日规则已保存", `共 ${normalized.length} 条日期配置`);
      onNotify(`法定节假日 JSON 已保存，共 ${normalized.length} 条`);
    } catch (error) { appendRunLog("error", "法定节假日规则保存失败", error.message); onNotify(`法定节假日 JSON 保存失败：${error.message}`); }
  };

  const saveSickLeavePolicy = () => {
    try {
      const parsed = JSON.parse(sickLeavePolicyJson);
      const rows = Array.isArray(parsed) ? parsed : parsed.rules;
      const normalized = (rows || []).map((item) => ({ service_min_years: Number(item.service_min_years), service_max_years: item.service_max_years === null || item.service_max_years === "" ? null : Number(item.service_max_years), within_6_months: Number(item.within_6_months), over_6_months: Number(item.over_6_months) })).filter((item) => item.service_min_years >= 0 && (item.service_max_years === null || item.service_max_years > item.service_min_years) && item.within_6_months >= 0 && item.over_6_months >= 0);
      if (!normalized.length) throw new Error("至少需要一条有效的司龄区间和比例");
      if (!sickLeaveHireDateField || !sickLeaveBaseField) throw new Error("请选择入职日期字段和计算基数字段");
      const cap = JSON.parse(sickLeaveCapJson);
      if (cap.enabled && cap.mode === "fixed_amount" && Number(cap.amount) <= 0) throw new Error("封顶金额必须是正数");
      setSickLeavePolicy(normalized); setSickLeavePolicyJson(JSON.stringify(normalized, null, 2)); localStorage.setItem("payroll-sick-leave-policy", JSON.stringify(normalized)); localStorage.setItem("payroll-sick-leave-hire-date-field", sickLeaveHireDateField); localStorage.setItem("payroll-sick-leave-base-field", sickLeaveBaseField);
      localStorage.setItem("payroll-sick-leave-cap", JSON.stringify(cap)); setSickLeaveCapJson(JSON.stringify(cap, null, 2));
      appendRunLog("success", "病假工资规则已保存", `共 ${normalized.length} 个司龄区间`);
      onNotify(`病假工资规则已保存，共 ${normalized.length} 个司龄区间`);
    } catch (error) { appendRunLog("error", "病假工资规则保存失败", error.message); onNotify(`病假工资规则保存失败：${error.message}`); }
  };

  const saveMinimumWageRule = () => {
    try {
      const parsed = JSON.parse(minimumWageJson);
      if (!parsed || Number(parsed.monthly_minimum_wage) <= 0) throw new Error("monthly_minimum_wage 必须是正数");
      if (!netIncomeField || !absenceDaysField || !standardWorkDaysField) throw new Error("请选择税后收入、缺勤天数和应出勤天数字段");
      const normalized = { ...parsed, monthly_minimum_wage: Number(parsed.monthly_minimum_wage) };
      setMinimumWageRule(normalized); setMinimumWageJson(JSON.stringify(normalized, null, 2)); localStorage.setItem("payroll-minimum-wage-rule", JSON.stringify(normalized)); localStorage.setItem("payroll-net-income-field", netIncomeField); localStorage.setItem("payroll-absence-days-field", absenceDaysField); localStorage.setItem("payroll-standard-work-days-field", standardWorkDaysField); appendRunLog("success", "最低工资与病假保底规则已保存", "已保存金额规则及三个关联字段"); onNotify("最低工资与病假保底规则已保存");
    } catch (error) { appendRunLog("error", "最低工资规则保存失败", error.message); onNotify(`最低工资规则保存失败：${error.message}`); }
  };

  const saveAttendanceSchedule = () => {
    try {
      const parsed = JSON.parse(attendanceScheduleJson);
      const rows = Array.isArray(parsed) ? parsed : parsed.months;
      const normalized = (rows || []).map((item) => ({ year: Number(item.year || item["年份"]), month: Number(item.month || item["月份"]), calendar_days: Number(item.calendar_days || item["当月天数"] || 0), double_rest_work_days: Number(item.double_rest_work_days || item["双休模式应出勤天数"] || 0), single_rest_work_days: Number(item.single_rest_work_days || item["做六休一模式应出勤天数"] || 0), notes: String(item.notes || item["备注"] || "").trim() })).filter((item) => item.year > 0 && item.month >= 1 && item.month <= 12 && item.double_rest_work_days > 0 && item.single_rest_work_days > 0);
      if (!normalized.length) throw new Error("至少需要一条有效的年度、月份和两种班次应出勤天数");
      setAttendanceSchedule(normalized); setAttendanceScheduleJson(JSON.stringify(normalized, null, 2)); localStorage.setItem("payroll-attendance-schedule", JSON.stringify(normalized)); localStorage.setItem("payroll-shift-field", shiftField); localStorage.setItem("payroll-attendance-mode", attendanceMode); appendRunLog("success", "排班应出勤规则已保存", `班次模式：${attendanceMode}；共 ${normalized.length} 个月`); onNotify(`排班应出勤规则已保存，共 ${normalized.length} 个月`);
    } catch (error) { appendRunLog("error", "排班应出勤规则保存失败", error.message); onNotify(`排班应出勤规则保存失败：${error.message}`); }
  };

  const updateCustomLogic = (name, changes) => {
    setLogicValidated(false);
    setCalculationCompleted(false);
    setValidationIssues([]);
    setCustomOutputs((items) => items.map((item) => item.name === name ? { ...item, ...changes, ...(changes.description !== undefined ? { generatedCode: "", status: "待解析" } : {}), status: changes.description !== undefined ? "待解析" : (changes.status || item.status) } : item));
  };
  const generateCustomCode = async (item) => {
    if (!item.description.trim()) { onNotify(`请先描述 ${item.logicName} 的计算逻辑`); return; }
    try {
      const result = await requestGeneratedCode({ ...item, project: item.logicName, scope: "global" });
      updateCustomLogic(item.name, { status: "已解析", generatedCode: result.python_code, codeSummary: result.summary, reviewNotes: result.review_notes });
      onNotify(`AI 已理解 ${item.logicName}，已生成待审核的 Python 代码`);
    } catch (error) {
      onNotify(`AI 代码生成失败：${error.message}`);
    }
  };

  const validateDescription = (logicName, description) => {
    const issues = [];
    if (!logicName.trim()) issues.push("逻辑名称不能为空");
    if (!description.trim()) issues.push(`${logicName || "该逻辑"}尚未填写自然语言计算逻辑`);
    if (description.includes("@")) {
      const referencePattern = /@([a-z][a-z0-9_]*)\.([a-z][a-z0-9_]*)/gi;
      const references = [...description.matchAll(referencePattern)];
      if (description.replace(referencePattern, "").includes("@")) issues.push(`${logicName || "该逻辑"}存在未完成的字段引用，请从候选项中选择`);
      references.forEach((match) => {
        if (!availableFields.includes(`${match[1]}.${match[2]}`)) issues.push(`${logicName || "该逻辑"}引用了不存在的字段 @${match[1]}.${match[2]}`);
      });
    }
    return issues;
  };

  const validateBeforeCalculation = () => {
    const issues = [];
    const availableSourceRefs = new Set(sourceFieldChoices.map((field) => `${field.table_name}.${field.field_name}`));
    if (!outputTemplateFields.length) issues.push("请先在输出页确认最终输出模板");
    outputTemplateFields.forEach((field) => {
      const rule = outputFieldRules[field.name];
      if (!rule) issues.push(`输出字段 ${field.display_name || field.name} 尚未配置取值方式`);
      else if (rule.mode === "source" && !rule.source_ref) issues.push(`输出字段 ${field.display_name || field.name} 尚未选择数据来源`);
      else if (rule.mode === "source" && !availableSourceRefs.has(rule.source_ref)) issues.push(`输出字段 ${field.display_name || field.name} 引用了不存在的数据或输出字段：${rule.source_ref}`);
      else if (rule.mode === "formula" && (rule.status !== "已解析" || !rule.generated_code)) issues.push(`输出字段 ${field.display_name || field.name} 尚未生成并确认计算逻辑`);
    });
    issues.push(...getOutputDependencyIssues(outputTemplateFields, outputFieldRules));
    temporaryFields.forEach((field) => { if (!field.description?.trim()) issues.push(`临时字段 ${field.display_name || field.name} 尚未填写计算逻辑`); else if (field.status !== "已解析" || !field.generated_code) issues.push(`临时字段 ${field.display_name || field.name} 尚未生成并确认计算逻辑`); });
    issues.push(...getTemporaryDependencyIssues(temporaryFields));
    statutoryRules.forEach((rule) => {
      validateDescription(rule.project, rule.description).forEach((issue) => issues.push(`法定计算逻辑：${issue}`));
      if (rule.status !== "已解析") issues.push(`${rule.project || "未命名法定逻辑"}尚未解析`);
    });
    globalRules.forEach((rule) => {
      validateDescription(rule.project, rule.description).forEach((issue) => issues.push(issue));
      if (rule.status !== "已解析") issues.push(`${rule.project || "未命名全局逻辑"}尚未解析`);
    });
    tableRules.forEach((rule) => {
      const tableLabel = dataTables.find((table) => table.technical === rule.table)?.name || rule.table;
      validateDescription(rule.project, rule.description).forEach((issue) => issues.push(`${tableLabel}：${issue}`));
      if (rule.status !== "已解析") issues.push(`${rule.project || "未命名单表逻辑"}尚未解析`);
    });
    customOutputs.forEach((item) => {
      validateDescription(item.logicName, item.description).forEach((issue) => issues.push(`输出字段 ${item.name}：${issue}`));
      if (item.status !== "已解析") issues.push(`输出字段 ${item.name} 尚未完成计算逻辑解析`);
    });
    temporaryFields.forEach((field) => { if (field.generated_code) issues.push(...inspectGeneratedPythonCode(field.generated_code, `临时字段：${field.display_name || field.name}`)); });
    outputTemplateFields.forEach((field) => {
      const rule = outputFieldRules[field.name];
      if (rule?.generated_code) issues.push(...inspectGeneratedPythonCode(rule.generated_code, `输出字段：${field.display_name || field.name}（${field.name}）`));
    });
    [...statutoryRules, ...globalRules, ...tableRules].forEach((rule) => {
      if (rule.generatedCode) issues.push(...inspectGeneratedPythonCode(rule.generatedCode, rule.project || rule.id));
    });
    customOutputs.forEach((item) => {
      if (item.generatedCode) issues.push(...inspectGeneratedPythonCode(item.generatedCode, `输出字段：${item.logicName || item.name}`));
    });
    return [...new Set(issues)];
  };

  const startCalculation = async () => {
    const calculationRules = { statutory: statutoryRules, statutory_holidays: holidayCalendar, attendance_schedule: attendanceSchedule, attendance_mode: attendanceMode, shift_field: shiftField, sick_leave_policy: sickLeavePolicy, sick_leave_high_income_cap: JSON.parse(sickLeaveCapJson || "{}"), sick_leave_hire_date_field: sickLeaveHireDateField, sick_leave_base_field: sickLeaveBaseField, minimum_wage_rule: minimumWageRule, net_income_field: netIncomeField, absence_days_field: absenceDaysField, standard_work_days_field: standardWorkDaysField, temporary: temporaryFields, global: globalRules, table: tableRules, custom: customOutputs };
    if (logicValidated) {
      if (!validatedModelVersion) {
        setLogicValidated(false);
        onNotify("已校验模型已失效，请重新执行逻辑校验");
        return;
      }
      setCalculationRunning(true);
      try {
        appendRunLog("info", "开始执行 Python 核算", "正在读取当前组织已确认的输入表、输出规则和计算逻辑");
        const response = await localApiFetch("http://127.0.0.1:8787/api/calculation/run", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model_version_id: validatedModelVersion,
            period: "2026-08",
          }),
        });
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error || "Python 核算失败");
        setCalculationCompleted(true);
        appendRunLog("success", "Python 核算完成", `已写入 ${payload.record_count || 0} 条结果`);
        onNotify(`Python 核算完成，已写入 ${payload.record_count || 0} 条结果`);
      } catch (error) {
        appendRunLog("error", "Python 核算失败", error.message);
        onNotify(`核算失败：${error.message}`);
      } finally {
        setCalculationRunning(false);
      }
      return;
    }
    const issues = validateBeforeCalculation();
    const codeItems = [
      ...outputTemplateFields.map((field) => ({ label: `输出字段：${field.display_name || field.name}（${field.name}）`, code: outputFieldRules[field.name]?.generated_code || "" })),
      ...temporaryFields.map((field) => ({ label: `临时字段：${field.display_name || field.name}（${field.name}）`, code: field.generated_code || "" })),
      ...statutoryRules.map((rule) => ({ label: rule.project || rule.id, code: rule.generatedCode || "" })),
      ...globalRules.map((rule) => ({ label: rule.project || rule.id, code: rule.generatedCode || "" })),
      ...tableRules.map((rule) => ({ label: rule.project || rule.id, code: rule.generatedCode || "" })),
      ...customOutputs.map((rule) => ({ label: `输出字段：${rule.logicName || rule.name}`, code: rule.generatedCode || "" })),
    ].filter((item) => item.code);
    let validationPayload = null;
    try {
      const validationResponse = await localApiFetch("http://127.0.0.1:8787/api/calculation/validate-code", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model_version: "v1.3", items: codeItems, rules: calculationRules }) });
      validationPayload = await validationResponse.json();
      if (!validationResponse.ok) throw new Error(validationPayload.error || "Python 代码校验服务不可用");
      issues.push(...(validationPayload.issues || []));
    } catch (error) {
      issues.push(`Python 代码安全校验失败：${error.message}`);
    }
    const uniqueIssues = [...new Set(issues)];
    setValidationIssues(uniqueIssues);
    if (uniqueIssues.length > 0) {
      appendRunLog("error", "核算前校验未通过", `发现 ${uniqueIssues.length} 个问题，尚未执行 Python 核算`);
      onNotify(`核算前校验未通过：发现 ${uniqueIssues.length} 个问题`);
      return;
    }
    setValidatedModelVersion(validationPayload.model_version_id || "");
    setLogicValidated(true);
    appendRunLog("success", "核算前逻辑校验通过", "可以开始执行 Python 核算");
    onNotify("逻辑校验通过，请点击“开始核算”执行");
  };

  const exportCalculationResult = async () => {
    try {
      const response = await localApiFetch("http://127.0.0.1:8787/api/calculation/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ file_name: `立天世纪_薪酬与提成核算_${getLocalDate()}.xlsx` }),
      });
      if (!response.ok) {
        const payload = await response.json();
        throw new Error(payload.error || "结果导出失败");
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `立天世纪_薪酬与提成核算_${getLocalDate()}.xlsx`;
      link.click();
      URL.revokeObjectURL(url);
      onNotify("已从 SQLite 结果表导出 Excel 文件");
    } catch (error) {
      onNotify(`结果导出失败：${error.message}`);
    }
  };

  const askCalculationRepair = async () => {
    if (!lastRunError && !repairRequest.trim()) { onNotify("请先填写需要诊断的报错信息或修复要求"); return; }
    setRepairLoading(true);
    setRepairAnswer("");
    try {
      const response = await localApiFetch("http://127.0.0.1:8787/api/ai/calculation-repair", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          error_summary: lastRunError ? `${lastRunError.message}：${lastRunError.detail || ""}` : "",
          request: repairRequest,
          context: {
            stage: calculationRunning ? "running" : calculationCompleted ? "completed" : logicValidated ? "validated" : "configuration",
            model_version: "v1.3",
            participating_tables: participatingTableCount,
            participating_fields: participatingFieldCount,
            generated_code: `${generatedLogicCount}/${codeTargetCount}`,
            validation_issue_count: validationIssues.length,
          },
        }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "AI 修复分析失败");
      setRepairAnswer(payload.answer || "AI 未返回修复建议");
      appendRunLog("info", "已获取 AI 核算修复建议", "仅发送错误摘要与配置元数据，未发送真实业务明细");
      onNotify("已获取 AI 修复建议，请审核后再修改逻辑或重新运行");
    } catch (error) {
      appendRunLog("error", "AI 核算修复分析失败", error.message);
      onNotify(`AI 修复分析失败：${error.message}`);
    } finally { setRepairLoading(false); }
  };

  const packageEntries = (logicPackage) => [
    ...(logicPackage.statutoryRules || []).map((rule) => ({ key: `statutory:${rule.id}`, scope: "法定逻辑", name: rule.project, detail: rule.description })),
    ...(logicPackage.globalRules || []).map((rule) => ({ key: `global:${rule.id}`, scope: "全局逻辑", name: rule.project, detail: rule.description })),
    ...(logicPackage.tableRules || []).map((rule) => ({ key: `table:${rule.id}`, scope: "单表逻辑", name: rule.project, detail: `${dataTables.find((table) => table.technical === rule.table)?.name || rule.table} · ${rule.description}` })),
    ...(logicPackage.customOutputs || []).map((item) => ({ key: `output:${item.name}`, scope: "输出字段逻辑", name: item.logicName, detail: `${item.name} · ${item.description}` })),
  ];

  const getLocalDate = () => {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  };

  const openExportDialog = () => {
    const logicPackage = { statutoryRules, globalRules, tableRules, customOutputs };
    setPackageDialog({ mode: "export", fileName: `立天世纪_薪酬与提成核算_${getLocalDate()}`, logicPackage, selected: packageEntries(logicPackage).map((entry) => entry.key) });
  };

  const exportLogicPackage = () => {
    const selection = packageDialog?.selected || [];
    const selected = new Set(selection);
    const logicPackage = {
      packageType: "payroll-calculation-logic",
      version: "1.0",
      exportedAt: new Date().toISOString(),
      statutoryRules: (packageDialog.logicPackage.statutoryRules || []).filter((rule) => selected.has(`statutory:${rule.id}`)),
      globalRules: (packageDialog.logicPackage.globalRules || []).filter((rule) => selected.has(`global:${rule.id}`)),
      tableRules: (packageDialog.logicPackage.tableRules || []).filter((rule) => selected.has(`table:${rule.id}`)),
      customOutputs: (packageDialog.logicPackage.customOutputs || []).filter((item) => selected.has(`output:${item.name}`)),
    };
    if (!logicPackage.statutoryRules.length && !logicPackage.globalRules.length && !logicPackage.tableRules.length && !logicPackage.customOutputs.length) {
      onNotify("请至少选择一条需要导出的计算逻辑");
      return;
    }
    const fileName = (packageDialog.fileName || "薪酬计算逻辑").trim().replace(/\.json$/i, "") || "薪酬计算逻辑";
    const blob = new Blob([JSON.stringify(logicPackage, null, 2)], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${fileName}.json`;
    link.click();
    URL.revokeObjectURL(url);
    setPackageDialog(null);
    onNotify("当前计算逻辑已导出");
  };

  const importLogicPackage = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    try {
      const logicPackage = JSON.parse(await file.text());
      if (logicPackage.packageType !== "payroll-calculation-logic" || (logicPackage.statutoryRules !== undefined && !Array.isArray(logicPackage.statutoryRules)) || !Array.isArray(logicPackage.globalRules) || !Array.isArray(logicPackage.tableRules) || !Array.isArray(logicPackage.customOutputs)) {
        throw new Error("文件不是有效的薪酬计算逻辑包");
      }
      setPackageDialog({ mode: "import", fileName: file.name, logicPackage, selected: packageEntries(logicPackage).map((entry) => entry.key), error: "" });
    } catch (error) {
      onNotify(`导入失败：${error.message}`);
    }
  };

  const validateImportedRelations = (logicPackage, selected) => {
    const issues = [];
    const selectedKeys = new Set(selected);
    const validateReferences = (label, description) => {
      const referencePattern = /@([a-z][a-z0-9_]*)\.([a-z][a-z0-9_]*)/gi;
      const references = [...String(description || "").matchAll(referencePattern)];
      if (String(description || "").includes("@") && String(description || "").replace(referencePattern, "").includes("@")) issues.push(`${label}存在未完成的表字段引用`);
      references.forEach((match) => {
        const fields = tableMappings[match[1]];
        if (!fields) issues.push(`${label}涉及当前不存在的数据表：${match[1]}`);
        else if (!fields.some((field) => field.db === match[2])) issues.push(`${label}涉及当前不存在的字段：${match[1]}.${match[2]}`);
      });
    };
    (logicPackage.statutoryRules || []).filter((rule) => selectedKeys.has(`statutory:${rule.id}`)).forEach((rule) => validateReferences(`法定逻辑“${rule.project}”`, rule.description));
    (logicPackage.globalRules || []).filter((rule) => selectedKeys.has(`global:${rule.id}`)).forEach((rule) => validateReferences(`全局逻辑“${rule.project}”`, rule.description));
    (logicPackage.tableRules || []).filter((rule) => selectedKeys.has(`table:${rule.id}`)).forEach((rule) => {
      if (!dataTables.some((table) => table.technical === rule.table)) issues.push(`单表逻辑“${rule.project}”涉及当前不存在的数据表：${rule.table}`);
      validateReferences(`单表逻辑“${rule.project}”`, rule.description);
    });
    (logicPackage.customOutputs || []).filter((item) => selectedKeys.has(`output:${item.name}`)).forEach((item) => validateReferences(`输出字段“${item.name}”`, item.description));
    return [...new Set(issues)];
  };

  const confirmImportLogicPackage = () => {
    const selected = packageDialog?.selected || [];
    const logicPackage = packageDialog.logicPackage;
    const relationIssues = validateImportedRelations(logicPackage, selected);
    if (relationIssues.length > 0) {
      setPackageDialog((dialog) => ({ ...dialog, error: relationIssues }));
      return;
    }
    const selectedKeys = new Set(selected);
    const incomingStatutory = (logicPackage.statutoryRules || []).filter((rule) => selectedKeys.has(`statutory:${rule.id}`));
    const incomingGlobal = (logicPackage.globalRules || []).filter((rule) => selectedKeys.has(`global:${rule.id}`));
    const incomingTable = (logicPackage.tableRules || []).filter((rule) => selectedKeys.has(`table:${rule.id}`));
    const incomingOutput = (logicPackage.customOutputs || []).filter((item) => selectedKeys.has(`output:${item.name}`));
    setStatutoryRules((current) => [...current.filter((rule) => !incomingStatutory.some((item) => item.id === rule.id)), ...incomingStatutory]);
    setGlobalRules((current) => [...current.filter((rule) => !incomingGlobal.some((item) => item.id === rule.id)), ...incomingGlobal]);
    setTableRules((current) => [...current.filter((rule) => !incomingTable.some((item) => item.id === rule.id)), ...incomingTable]);
    setCustomOutputs((current) => [...current.filter((item) => !incomingOutput.some((incoming) => incoming.name === item.name)), ...incomingOutput]);
    setValidationIssues([]);
    setLogicValidated(false);
    setPackageDialog(null);
    onNotify("已导入所选计算逻辑，请重新进行逻辑校验");
  };

  const togglePackageSelection = (key) => setPackageDialog((dialog) => ({ ...dialog, selected: dialog.selected.includes(key) ? dialog.selected.filter((item) => item !== key) : [...dialog.selected, key], error: "" }));

  return (
    <section className="page-frame">
      <PageHeading
        title="核算逻辑配置"
        description="输出页确定最终结果模板；数据页导入核算所需的输入子表；Python 按已确认逻辑读取这些子表并写入结果表。"
      >
        <button className="button secondary" onClick={openExportDialog}><FileArchive size={16} />导出逻辑包</button>
        <button className="button secondary" onClick={() => logicPackageInputRef.current?.click()}><Upload size={16} />导入逻辑包</button>
        <input ref={logicPackageInputRef} className="hidden-file" type="file" accept="application/json,.json" onChange={importLogicPackage} />
        <button
          className="button primary"
          onClick={calculationCompleted ? exportCalculationResult : startCalculation}
          disabled={calculationRunning}
        >
          {calculationCompleted ? <FileOutput size={16} /> : <Play size={16} />}
          {calculationRunning ? "核算中…" : calculationCompleted ? "导出结果" : logicValidated ? "开始核算" : "逻辑校验"}
        </button>
      </PageHeading>
      <section className="run-layout">
        <div className="panel run-ready">
          <div className="calculation-live-overview" aria-live="polite">
            <div className="calculation-live-heading">
              <div><span className="live-indicator" aria-hidden="true" /><strong>当前核算配置</strong></div>
              <small>实时更新</small>
            </div>
            <div className="calculation-live-metrics">
              <div><span>参与核算的数据表</span><strong>{participatingTableCount} 张</strong></div>
              <div><span>参与核算的字段</span><strong>{participatingFieldCount} 个</strong></div>
            </div>
            <div className="calculation-status-strip">
              {calculationConfigurationStatuses.map((item) => <div className={`calculation-status-item ${item.complete ? "is-complete" : item.empty ? "is-empty" : "is-pending"}`} key={item.key}>
                <span className="calculation-status-mark">{item.complete ? <Check size={12} /> : <span />}</span>
                <div><small>{item.label}</small><strong>{item.value}</strong>{item.detail && <em>{item.detail}</em>}</div>
                <b>{item.complete ? "已完成" : item.empty ? "未配置" : "待完成"}</b>
              </div>)}
            </div>
          </div>
          <section className="logic-workbench">
            <section className="logic-section temporary-fields-section">
              <div className="logic-section-heading"><div><h4>临时计算字段</h4><p>临时字段只在本次核算中保存，不写入最终 Excel。可用 <code>@temp.字段名</code> 让后续临时字段或输出字段复用结果；临时字段不能引用输出字段，系统会检查循环依赖。</p></div><div className="logic-section-actions"><button className="button secondary compact" onClick={addTemporaryField}><Plus size={14} />新增临时字段</button><button className="button primary compact" disabled={temporaryFieldsSaving} onClick={() => saveTemporaryFields()}><Check size={14} />{temporaryFieldsSaving ? "保存中…" : "保存临时字段"}</button></div></div>
              {!temporaryFields.length && <div className="run-logic-empty">暂无临时字段。适合将多项提成、补贴等中间结果分别计算后，再汇总到最终输出字段。</div>}
              {temporaryFields.map((field) => { const expanded = expandedTemporaryFieldNames.has(field.name); return <article className={`logic-rule-card temporary-field-card ${expanded ? "is-expanded" : "is-collapsed"}`} key={field.name}>{!expanded ? <button type="button" className="output-rule-summary-button" onClick={() => setExpandedTemporaryFieldNames((names) => { const next = new Set(names); next.add(field.name); return next; })}><span><b>{field.display_name || field.name}</b><small>{field.name} · 优先级 {field.priority || 100}</small></span><span><em>{field.status}</em><ChevronRight size={16} /></span></button> : <><div className="logic-rule-fields"><label><span>字段名（英文）</span><input value={field.name} onChange={(event) => updateTemporaryField(field.name, { name: event.target.value.trim().toLowerCase().replace(/[^a-z0-9_]/g, "_") })} /></label><label><span>显示名称</span><input value={field.display_name} onChange={(event) => updateTemporaryField(field.name, { display_name: event.target.value })} /></label><label className="priority-field"><span>优先级</span><input type="number" min="1" value={field.priority || 100} onChange={(event) => updateTemporaryField(field.name, { priority: Number(event.target.value) || 1 })} /></label><em>{field.status}</em><button className="small-icon rule-delete" aria-label="删除临时字段" onClick={() => removeTemporaryField(field.name)}><Trash2 size={14} /></button></div><LogicDescriptionInput value={field.description || ""} onChange={(description) => updateTemporaryField(field.name, { description })} placeholder="例如：销售提成 = @sales_detail.sales_amount × 对应提成比例；后续可使用 @temp.sales_commission。" referenceOptions={referenceCompletionOptions} /><small className="output-reference-hint">临时字段计算后请以当前字段名返回；输出字段可直接引用 <code>@temp.{field.name}</code>。</small><GeneratedCodePreview rule={{ generatedCode: field.generated_code, codeSummary: field.codeSummary, reviewNotes: field.reviewNotes }} /><div className="temporary-field-actions"><button className="button primary compact" disabled={temporaryFieldsSaving} onClick={() => completeTemporaryField(field)}><Check size={14} />{temporaryFieldsSaving ? "保存中…" : "完成并收起"}</button><button className="button secondary compact" onClick={() => setExpandedTemporaryFieldNames((names) => { const next = new Set(names); next.delete(field.name); return next; })}>取消</button></div></>}</article>; })}
            </section>
            <div className="logic-workbench-intro">
          <div><h3>计算逻辑编排</h3><p>先完成全部自然语言描述，再统一生成代码；系统会按输出字段依赖自动分批处理，每批完成后回写待审核代码，并在最后检查字段引用和循环依赖。</p></div>
              <div className="logic-workbench-actions"><button className={`button primary compact ${generationFeedback?.type === "error" ? "generation-error-button" : ""}`} disabled={batchGenerating} onClick={generateAllCalculationCode}><Code2 size={14} />{batchGenerating ? `分批生成中 ${batchProgress.current}/${batchProgress.total}…` : generationFeedback?.message || "统一生成 Python 代码"}</button></div>
            </div>
            <div className="logic-priority-note"><ShieldCheck size={15} /><span>执行优先级：<b>法定计算逻辑</b> 高于 <b>单表计算逻辑</b>，单表逻辑高于 <b>全局计算逻辑</b>；同一类逻辑按优先级数值从小到大执行。</span></div>
            {validationIssues.length > 0 && <div className="logic-validation-panel"><div><CircleCheck size={16} /><strong>核算前校验未通过</strong></div><ul>{validationIssues.map((issue) => <li key={issue}>{issue}</li>)}</ul><small>请先完成每条逻辑配置，再点击顶部“统一生成 Python 代码”生成解析结果后开始核算。</small></div>}

            <section className="logic-section statutory-logic-section">
              <div className="logic-section-heading">
                <div><h4>法定计算逻辑 <span>优先级最高</span></h4><p>用于个税、社保、公积金、最低工资等需依据法律法规执行的计算规则。</p></div>
                {statutoryConfigOpen ? <button className="button secondary compact" onClick={() => setStatutoryConfigOpen(false)}><ChevronLeft size={14} />返回核算页</button> : <button className="button primary compact" onClick={() => setStatutoryConfigOpen(true)}><Settings size={14} />进入法定规则配置</button>}
              </div>
              {statutoryConfigOpen ? <div className="statutory-config-content">
              <div className="statutory-config-toolbar"><span>法定规则配置</span><button className="button secondary compact" onClick={() => addRule("statutory")}><Plus size={14} />插入法定计算逻辑</button></div>
              <div className="holiday-calendar-panel"><div><strong>法定节假日三倍工资日期</strong><small>出勤日期命中下列日期时，法定假日加班工资按对应倍数计算。请直接编辑下方 JSON，校验后保存规则。</small></div><div className="holiday-calendar-actions"><button className="button primary compact" onClick={saveHolidayCalendar}><Check size={14} />保存规则</button></div><textarea className="holiday-json-editor" value={holidayJsonText} onChange={(event) => setHolidayJsonText(event.target.value)} spellCheck="false" aria-label="法定节假日 JSON 配置" /><div className="holiday-calendar-list">{holidayCalendar.map((item, index) => <span key={`${item.year}-${item.date}-${index}`}>{item.year} · {item.date} · {item.multiplier}倍</span>)}</div></div>
              <div className="sick-leave-policy-panel"><div className="sick-leave-policy-heading"><div><strong>病假工资计算规则</strong><small>Python 根据入职日期计算司龄，再按病假时长和下方比例计算病假工资；高收入人员按上海上年度月平均工资封顶。</small></div><button className="button primary compact" onClick={saveSickLeavePolicy}><Check size={14} />保存规则</button></div><div className="sick-leave-field-picks"><label><span>入职日期字段</span><InputFieldPicker value={sickLeaveHireDateField} options={sourceFieldChoices} onChange={setSickLeaveHireDateField} /></label><label><span>病假工资计算基数</span><InputFieldPicker value={sickLeaveBaseField} options={sourceFieldChoices} onChange={setSickLeaveBaseField} /></label></div><label className="policy-json-label"><span>司龄比例 JSON</span><textarea className="holiday-json-editor" value={sickLeavePolicyJson} onChange={(event) => setSickLeavePolicyJson(event.target.value)} spellCheck="false" aria-label="病假工资 JSON 配置" /></label><label className="policy-json-label"><span>高收入封顶 JSON</span><textarea className="holiday-json-editor compact-json-editor" value={sickLeaveCapJson} onChange={(event) => setSickLeaveCapJson(event.target.value)} spellCheck="false" aria-label="病假工资高收入封顶 JSON 配置" /></label></div>
              <div className="minimum-wage-policy-panel"><div className="sick-leave-policy-heading"><div><strong>最低工资保底与病假保底</strong><small>上海月最低工资当前按 2740 元初始化；先按满勤状态检查并补足法定最低工资，再恢复并执行实际考勤扣减，病假期间分别按 80% / 60% 保底。</small></div><button className="button primary compact" onClick={saveMinimumWageRule}><Check size={14} />保存规则</button></div><div className="sick-leave-field-picks"><label><span>税后收入字段</span><InputFieldPicker value={netIncomeField} options={sourceFieldChoices} onChange={setNetIncomeField} /></label><label><span>缺勤天数字段</span><InputFieldPicker value={absenceDaysField} options={sourceFieldChoices} onChange={setAbsenceDaysField} /></label><label><span>应出勤天数字段</span><InputFieldPicker value={standardWorkDaysField} options={sourceFieldChoices} onChange={setStandardWorkDaysField} /></label></div><textarea className="holiday-json-editor" value={minimumWageJson} onChange={(event) => setMinimumWageJson(event.target.value)} spellCheck="false" aria-label="最低工资保底 JSON 配置" /><div className="attendance-schedule-heading"><div><strong>月度排班应出勤 JSON</strong><small>先选择适用的班次模式；选择“自定义”时，再通过员工班次字段决定每个人使用单休或双休天数。</small></div><button className="button secondary compact" onClick={saveAttendanceSchedule}><Check size={14} />保存规则</button></div><label className="attendance-mode-picker"><span>班次模式</span><select value={attendanceMode} onChange={(event) => { setAttendanceMode(event.target.value); localStorage.setItem("payroll-attendance-mode", event.target.value); }}><option value="all_double">所有人都是双休模式</option><option value="all_single">所有人都是单休模式</option><option value="custom">自定义</option></select></label>{attendanceMode === "custom" && <label className="attendance-mode-picker"><span>员工班次字段</span><InputFieldPicker value={shiftField} options={sourceFieldChoices} onChange={setShiftField} /></label>}<textarea className="holiday-json-editor attendance-schedule-editor" value={attendanceScheduleJson} onChange={(event) => setAttendanceScheduleJson(event.target.value)} spellCheck="false" aria-label="月度排班应出勤 JSON 配置" /></div>
              {statutoryRules.length === 0 && <div className="run-logic-empty">尚未设置法定计算逻辑；如本次核算涉及个税、社保或公积金，请在此补充对应规则。</div>}
              {statutoryRules.map((rule) => (
                <article className="logic-rule-card" key={rule.id}>
                  <div className="logic-rule-fields">
                    <label><span>逻辑名称</span><input value={rule.project} onChange={(event) => updateRule("statutory", rule.id, { project: event.target.value })} placeholder="例如：居民个人所得税核算" /></label>
                    <label className="priority-field"><span>优先级</span><input type="number" min="1" value={rule.priority} onChange={(event) => updateRule("statutory", rule.id, { priority: Number(event.target.value) || 1 })} /></label>
                    <em>{rule.status}</em>
                    <button className="small-icon rule-delete" aria-label="删除法定计算逻辑" onClick={() => removeRule("statutory", rule.id)}><Trash2 size={14} /></button>
                  </div>
                  <LogicDescriptionInput value={rule.description} onChange={(description) => updateRule("statutory", rule.id, { description })} placeholder="例如：按现行累计预扣法计算居民个人所得税，并明确适用地区、生效日期、税率表及精度规则。" referenceOptions={referenceCompletionOptions} />
                  <button className="button secondary compact" onClick={() => generateRuleCode("statutory", rule)}><Code2 size={14} />{rule.status === "已解析" ? "已解析" : "待解析"}</button>
                  <GeneratedCodePreview rule={rule} />
                </article>
              ))}
              </div> : <button className="statutory-entry-card" onClick={() => setStatutoryConfigOpen(true)}><div><strong>法定计算逻辑配置</strong><span>法定节假日、病假工资、最低工资保底及法定计算规则</span></div><ChevronRight size={18} /></button>}
            </section>

            <section className="logic-section">
              <div className="logic-section-heading">
                <div><h4>全局计算逻辑</h4><p>适用于全部参与核算的数据，例如基础薪资、提成、应发金额等计算项目。</p></div>
                {globalConfigOpen ? <button className="button secondary compact" onClick={() => setGlobalConfigOpen(false)}><ChevronLeft size={14} />返回核算页</button> : <button className="button primary compact" onClick={() => setGlobalConfigOpen(true)}><Settings size={14} />进入全局规则配置</button>}
              </div>
              {globalConfigOpen ? <div className="global-config-content">
              <div className="statutory-config-toolbar global-config-toolbar"><span>全局规则配置</span><button className="button secondary compact" onClick={() => addRule("global")}><Plus size={14} />插入全局计算逻辑</button></div>
              {globalRules.map((rule) => (
                <article className="logic-rule-card" key={rule.id}>
                  <div className="logic-rule-fields">
                    <label><span>逻辑名称</span><input value={rule.project} onChange={(event) => updateRule("global", rule.id, { project: event.target.value })} placeholder="例如：薪酬基础核算" /></label>
                    <label className="priority-field"><span>优先级</span><input type="number" min="1" value={rule.priority} onChange={(event) => updateRule("global", rule.id, { priority: Number(event.target.value) || 1 })} /></label>
                    <em>{rule.status}</em>
                    <button className="small-icon rule-delete" aria-label="删除计算逻辑" onClick={() => removeRule("global", rule.id)}><Trash2 size={14} /></button>
                  </div>
                  <LogicDescriptionInput value={rule.description} onChange={(description) => updateRule("global", rule.id, { description })} placeholder="例如：按员工的基本工资和销售金额计算当月提成；销售额达到目标后按阶梯比例计算，最终金额保留两位小数。" referenceOptions={referenceCompletionOptions} />
                  <button className="button secondary compact" onClick={() => generateRuleCode("global", rule)}><Code2 size={14} />{rule.status === "已解析" ? "已解析" : "待解析"}</button>
                  <GeneratedCodePreview rule={rule} />
                </article>
              ))}
              {customOutputs.length > 0 && <div className="output-logic-divider"><span>输出字段计算逻辑</span><small>以下为输出页面新增字段的全局计算逻辑。</small></div>}
              {customOutputs.map((item) => <article className="logic-rule-card linked-output-rule" key={item.name}><div className="logic-rule-fields"><label className="locked-project"><span>逻辑名称</span><input value={item.logicName} onChange={(event) => updateCustomLogic(item.name, { logicName: event.target.value })} /><small>输出字段：{item.name} · {item.type}</small></label><label className="priority-field"><span>优先级</span><input type="number" min="1" value={item.priority || 100} onChange={(event) => updateCustomLogic(item.name, { priority: Number(event.target.value) || 1 })} /></label><em>{item.status}</em></div><LogicDescriptionInput value={item.description} onChange={(description) => updateCustomLogic(item.name, { description })} placeholder={`例如：用基本工资加上最终提成，生成 ${item.name}，结果保留两位小数。`} referenceOptions={referenceCompletionOptions} /><button className="button secondary compact" onClick={() => generateCustomCode(item)}><Code2 size={14} />{item.status === "已解析" ? "已解析" : "待解析"}</button><GeneratedCodePreview rule={item} /></article>)}
              </div> : <button className="logic-entry-card" onClick={() => setGlobalConfigOpen(true)}><div><strong>全局计算逻辑配置</strong><span>适用于全部数据的基础薪资、提成、应发金额及输出字段计算</span></div><ChevronRight size={18} /></button>}
            </section>

            <section className="logic-section table-logic-section">
              <div className="logic-section-heading">
                <div><h4>单表计算逻辑 <span>优先级高于全局逻辑</span></h4><p>用于处理某张表中的特殊数据情况，例如在考勤表中指定员工忽略缺勤天数。</p></div>
                <button className="button secondary compact" onClick={() => addRule("table")}><Plus size={14} />插入单表计算逻辑</button>
              </div>
              {tableRules.length === 0 && <div className="run-logic-empty">尚未设置单表特殊处理逻辑；如无特殊情况，系统只执行全局计算逻辑。</div>}
              {tableRules.map((rule) => <article className="logic-rule-card" key={rule.id}><div className="logic-rule-fields"><label className="table-rule-select"><span>目标数据表</span><select value={rule.table} onChange={(event) => updateRule("table", rule.id, { table: event.target.value })}>{inputTableOptions.map((table) => <option value={table.technical} key={table.technical}>{table.name}</option>)}</select></label><label><span>逻辑名称</span><input value={rule.project} onChange={(event) => updateRule("table", rule.id, { project: event.target.value })} placeholder="例如：缺勤豁免规则" /></label><em>{rule.status}</em><button className="small-icon rule-delete" aria-label="删除计算逻辑" onClick={() => removeRule("table", rule.id)}><Trash2 size={14} /></button></div><LogicDescriptionInput value={rule.description} onChange={(description) => updateRule("table", rule.id, { description })} placeholder="例如：对于员工编号为 E001 的记录，忽略缺勤天数扣减；其他员工仍按全局规则处理。" referenceOptions={referenceCompletionOptions} /><button className="button secondary compact output-rule-complete-action" onClick={() => completeTableRule(rule)}><Check size={14} />完成</button><GeneratedCodePreview rule={rule} /></article>)}
          </section>
          </section>
        </div>
        <aside className="run-side-rail">
          <section className="panel run-status-panel">
            <div className="run-status-heading">
              <div><h2>运行状态</h2><p>{lastRunError ? "本次流程发现错误，请查看下方详情。" : "本次核算将按以下步骤执行。"}</p></div>
              <Status status={lastRunError ? "有错误" : calculationRunning ? "执行中" : calculationCompleted ? "已完成" : logicValidated ? "可执行" : "待执行"} />
            </div>
            {lastRunError && <div className="run-error-banner" role="alert"><strong>{lastRunError.message}</strong><small>{lastRunError.detail || "请在下方输入框描述问题后请求 AI 分析。"}</small></div>}
            <div className="run-status-steps">
              <Step title="读取已发布模型" value="v1.3" status="已完成" />
              <Step title="锁定输入批次" value="2026-08 / Batch-003" status={logicValidated ? "已完成" : "待执行"} />
              <Step title="执行 Python 计算器" value="calculator.py" status={calculationRunning ? "执行中" : calculationCompleted ? "已完成" : lastRunError ? "有错误" : "待执行"} />
              <Step title="写入结果与审计快照" value="local_calculation_result" status={calculationCompleted ? "已完成" : "待执行"} />
            </div>
          </section>
          <section className="panel audit-preview">
            <ScrollText size={21} />
            <h2>运行完成后保留</h2>
            <p>运行日志和异常摘要会保留在当前会话。你可以用自然语言描述问题，让本地服务调用已配置的大模型生成修复建议。</p>
            <textarea className="run-repair-input" value={repairRequest} onChange={(event) => setRepairRequest(event.target.value)} placeholder="例如：导入数据后计算失败，请分析错误原因，并告诉我需要修改哪条核算逻辑。" aria-label="核算错误修复要求" />
            <button className="button primary compact run-repair-button" onClick={askCalculationRepair} disabled={repairLoading || (!lastRunError && !repairRequest.trim())}><Bot size={15} />{repairLoading ? "AI 分析中…" : "AI 分析并给出修复建议"}</button>
            {repairAnswer && <div className="run-repair-answer"><strong>AI 修复建议</strong><p>{repairAnswer}</p></div>}
          </section>
        </aside>
      </section>
      <OperationLogPanel
        title="核算操作日志"
        description="记录规则保存、统一生成 Python 代码、核算前校验、正式核算和导出过程的状态与错误摘要。"
        entries={runLogs}
        onClear={() => setRunLogs([])}
      />
      {packageDialog && <div className="dialog-backdrop"><section className="logic-package-dialog"><div className="dialog-heading"><div><h2>{packageDialog.mode === "export" ? "导出计算逻辑" : "导入计算逻辑"}</h2><p>{packageDialog.mode === "export" ? "选择需要打包的逻辑，最终会合并为一个 JSON 文件。" : `已读取 ${packageDialog.fileName}，请选择要导入的逻辑。导入前会校验表和字段引用。`}</p></div><button className="icon-button" onClick={() => setPackageDialog(null)}><X size={17} /></button></div>{packageDialog.mode === "export" && <label className="logic-package-name"><span>导出文件名</span><input value={packageDialog.fileName} onChange={(event) => setPackageDialog((dialog) => ({ ...dialog, fileName: event.target.value }))} placeholder="星河科技（上海）有限公司_薪酬与提成核算_YYYY-MM-DD" /><small>默认格式为“组织名称_逻辑名称_日期”，系统会自动添加 .json 后缀。</small></label>}<div className="logic-package-selection">{packageEntries(packageDialog.logicPackage).map((entry) => <label className="logic-package-item" key={entry.key}><input type="checkbox" checked={packageDialog.selected.includes(entry.key)} onChange={() => togglePackageSelection(entry.key)} /><div><strong>{entry.name || "未命名逻辑"}</strong><span>{entry.scope}</span><small>{entry.detail || "未填写逻辑描述"}</small></div></label>)}</div>{packageDialog.error && <div className="logic-package-error"><strong>导入校验失败</strong><ul>{(Array.isArray(packageDialog.error) ? packageDialog.error : [packageDialog.error]).map((issue) => <li key={issue}>{issue}</li>)}</ul><small>当前逻辑包未导入，原有计算逻辑保持不变。</small></div>}<div className="dialog-actions"><button className="button secondary" onClick={() => setPackageDialog(null)}>取消</button><button className="button primary" onClick={packageDialog.mode === "export" ? exportLogicPackage : confirmImportLogicPackage} disabled={!packageDialog.selected.length}>{packageDialog.mode === "export" ? "打包导出" : "校验并导入"}</button></div></section></div>}
    </section>
  );
}
function GeneratedCodePreview({ rule }) {
  if (!rule.generatedCode) return null;
  return <details className="generated-code-preview"><summary>查看 AI 生成的 Python 代码（待审核）</summary><p>{rule.codeSummary}</p><pre>{rule.generatedCode}</pre><small>{rule.reviewNotes}</small></details>;
}
function LogicDescriptionInput({ value, onChange, placeholder, referenceOptions, compact = false }) {
  const textareaRef = useRef(null);
  const referenceTables = useMemo(() => {
    const sourceOptions = referenceOptions || [];
    const tablesByName = new Map();
    sourceOptions.forEach((item) => {
      const [tableName, fieldName] = String(item.technical || "").split(".");
      if (!tableName || !fieldName || tableName === "output") return;
      const current = tablesByName.get(tableName) || { technical: tableName, name: String(item.label || tableName).split(" · ")[1] || tableName, fields: [] };
      const labelParts = String(item.label || fieldName).split(" · ");
      current.fields.push({ name: fieldName, label: labelParts[labelParts.length - 1] || fieldName });
      tablesByName.set(tableName, current);
    });
    const options = tablesByName.size ? Array.from(tablesByName.values()) : dataTables.map((table) => ({ technical: table.technical, name: table.name, fields: (tableMappings[table.technical] || []).map((field) => ({ name: field.db, label: field.excel })) }));
    const nameCounts = options.reduce((counts, table) => counts.set(table.name, (counts.get(table.name) || 0) + 1), new Map());
    return options.map((table) => ({ ...table, name: nameCounts.get(table.name) > 1 ? `${table.name}（${table.technical}）` : table.name }));
  }, [referenceOptions]);
  const [tableName, setTableName] = useState("");
  const [fieldName, setFieldName] = useState("");
  const [referenceQuery, setReferenceQuery] = useState(null);
  const selectedTable = referenceTables.find((table) => table.technical === tableName) || referenceTables[0];
  const fields = selectedTable?.fields || [];
  useEffect(() => {
    if (!selectedTable || (selectedTable.technical === tableName && fields.some((field) => field.name === fieldName))) return;
    setTableName(selectedTable.technical);
    setFieldName(selectedTable.fields[0]?.name || "");
  }, [selectedTable, tableName, fieldName, fields]);
  const builtInReferenceOptions = dataTables.flatMap((table) => (tableMappings[table.technical] || []).map((field) => ({
    token: `@${table.technical}.${field.db}`,
    label: `${table.name} · ${field.excel}`,
    technical: `${table.technical}.${field.db}`,
  })));
  const completionOptions = referenceOptions || builtInReferenceOptions;
  const suggestions = referenceQuery ? completionOptions.filter((item) => `${item.token} ${item.label}`.toLowerCase().includes(referenceQuery.query.toLowerCase())) : [];
  const handleDescriptionChange = (event) => {
    const nextValue = event.target.value;
    const caret = event.target.selectionStart || nextValue.length;
    const beforeCaret = nextValue.slice(0, caret);
    const match = beforeCaret.match(/@[^\s]*$/);
    onChange(nextValue);
    if (match) {
      setReferenceQuery({ start: caret - match[0].length, end: caret, query: match[0].slice(1) });
    } else {
      setReferenceQuery(null);
    }
  };
  const insertSuggestion = (suggestion) => {
    if (!referenceQuery) return;
    const nextValue = `${value.slice(0, referenceQuery.start)}${suggestion.token}${value.slice(referenceQuery.end)}`;
    const nextCaret = referenceQuery.start + suggestion.token.length;
    setReferenceQuery(null);
    onChange(nextValue);
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(nextCaret, nextCaret);
    });
  };
  const insertFieldReference = () => {
    if (!fieldName) return;
    const textarea = textareaRef.current;
    const start = textarea?.selectionStart ?? value.length;
    const end = textarea?.selectionEnd ?? start;
    const token = `@${tableName}.${fieldName}`;
    const nextValue = `${value.slice(0, start)}${token}${value.slice(end)}`;
    onChange(nextValue);
    requestAnimationFrame(() => {
      textarea?.focus();
      textarea?.setSelectionRange(start + token.length, start + token.length);
    });
  };
  return <label className={compact ? "output-rule-description" : "logic-description"}><span>自然语言计算逻辑</span><div className="logic-textarea-wrap"><textarea ref={textareaRef} value={value} onChange={handleDescriptionChange} placeholder={placeholder} />{suggestions.length > 0 && <div className="reference-suggestions"><div className="reference-suggestions-title">输入 @ 后选择要引用的数据页字段、临时字段或输出字段</div>{suggestions.map((suggestion) => <button type="button" key={suggestion.token} onMouseDown={(event) => event.preventDefault()} onClick={() => insertSuggestion(suggestion)}><strong>{suggestion.token}</strong><small>{suggestion.label}</small></button>)}</div>}</div></label>;
}
function Step({ title, value, status = "已完成" }) {
  const hasError = status === "有错误";
  return (
    <div className={`run-step ${hasError ? "has-error" : ""}`}>
      <span>
        {hasError ? <X size={15} /> : status === "执行中" ? <LoaderCircle size={15} className="spin" /> : status === "待执行" ? <span className="step-pending-dot" /> : <Check size={15} />}
      </span>
      <div>
        <strong>{title}</strong>
        <small>{status} · {value}</small>
      </div>
    </div>
  );
}
function AuditPage({ onNotify }) {
  const [versions, setVersions] = useState([]);
  const [auditEntries, setAuditEntries] = useState([]);
  const [auditIntegrity, setAuditIntegrity] = useState(null);
  const [versionName, setVersionName] = useState("");
  const [savingVersion, setSavingVersion] = useState(false);
  const [importingVersion, setImportingVersion] = useState(false);
  const versionInputRef = useRef(null);
  const loadHistory = async () => {
    try {
      const [versionsResponse, auditResponse] = await Promise.all([localApiFetch("http://127.0.0.1:8787/api/configuration-versions"), localApiFetch("http://127.0.0.1:8787/api/audit")]);
      const [versionPayload, auditPayload] = await Promise.all([versionsResponse.json(), auditResponse.json()]);
      if (!versionsResponse.ok || !auditResponse.ok) throw new Error(versionPayload.error || auditPayload.error || "历史记录读取失败");
      setVersions(versionPayload.items || []);
      setAuditEntries(auditPayload.items || []);
      setAuditIntegrity(auditPayload.integrity || null);
    } catch (error) { onNotify(`历史 / 审计读取失败：${error.message}`); }
  };
  useEffect(() => { loadHistory(); }, []);
  const saveVersion = async () => {
    if (!versionName.trim()) { onNotify("请填写配置版本名称"); return; }
    setSavingVersion(true);
    try {
      const response = await localApiFetch("http://127.0.0.1:8787/api/configuration-versions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ display_name: versionName.trim() }) });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "版本保存失败");
      setVersionName("");
      await loadHistory();
      onNotify(`已保存配置版本：${payload.display_name}`);
    } catch (error) { onNotify(`配置版本保存失败：${error.message}`); } finally { setSavingVersion(false); }
  };
  const exportVersion = async (version) => {
    try {
      const response = await localApiFetch(`http://127.0.0.1:8787/api/configuration-versions/export?version_id=${encodeURIComponent(version.version_id)}`);
      if (!response.ok) { const payload = await response.json(); throw new Error(payload.error || "配置版本读取失败"); }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `${version.display_name.replace(/[\\/:*?"<>|]/g, "_") || version.version_id}.zip`;
      link.click();
      URL.revokeObjectURL(url);
      onNotify(`已导出配置版本：${version.display_name}`);
    } catch (error) { onNotify(`配置版本导出失败：${error.message}`); }
  };
  const importVersion = async (file) => {
    if (!file) return;
    setImportingVersion(true);
    try {
      const body = new FormData();
      body.append("file", file, file.name);
      const response = await localApiFetch("http://127.0.0.1:8787/api/configuration-versions/import", { method: "POST", body });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "配置版本导入失败");
      await loadHistory();
      onNotify(`已导入配置版本：${payload.display_name}；业务数据未改变`);
    } catch (error) { onNotify(`配置版本导入失败：${error.message}`); }
    finally { setImportingVersion(false); if (versionInputRef.current) versionInputRef.current.value = ""; }
  };
  return <section className="page-frame">
    <PageHeading title="历史 / 审计" description="保存不含业务明细的配置快照，并导出输入结构、输出模板、字段规则及已确认的 Python 代码。" />
    <section className="panel configuration-version-panel">
      <div className="panel-title"><div><h2>配置版本</h2><p>每次保存都会冻结当前已持久化的配置；版本包不包含薪酬、考勤等业务明细数据。导入前会校验结构、代码、哈希和循环依赖。</p></div><div className="configuration-version-actions"><input ref={versionInputRef} type="file" accept=".zip,application/zip" hidden onChange={(event) => importVersion(event.target.files?.[0])} /><button className="button secondary compact" disabled={importingVersion} onClick={() => versionInputRef.current?.click()}><Upload size={14} />{importingVersion ? "导入中…" : "导入配置版本"}</button><button className="button secondary compact" onClick={loadHistory}><RefreshCw size={14} />刷新</button></div></div>
      <div className="configuration-version-create"><label><span>版本名称</span><input value={versionName} onChange={(event) => setVersionName(event.target.value)} placeholder="例如：2026-08 社保与考勤规则确认版" /></label><button className="button primary" disabled={savingVersion} onClick={saveVersion}><FileArchive size={15} />{savingVersion ? "保存中…" : "保存当前配置"}</button></div>
      <div className="configuration-version-list">{versions.length ? versions.map((version) => <article className="configuration-version-row" key={version.version_id}><span className="configuration-version-icon"><Archive size={16} /></span><div><strong>{version.display_name}</strong><code>{version.version_id}</code><small>{formatAuditTime(version.created_at)} · {version.summary.input_schema_count} 张输入表 · {version.summary.output_field_count} 个输出字段 · {version.summary.output_rule_count} 条字段规则 · {version.summary.global_logic_count + version.summary.temporary_field_count} 条逻辑</small></div><button className="button secondary compact" onClick={() => exportVersion(version)}><FileOutput size={14} />导出 ZIP</button></article>) : <div className="configuration-version-empty">尚未保存配置版本。保存后可在此导出包含 JSON 配置与 Python 代码的 ZIP 版本包。</div>}</div>
    </section>
    <section className="panel audit-table">
      <div className="panel-title"><div><h2>操作审计</h2><p>记录 Schema 确认、数据导入、规则保存、配置版本及核算运行等操作。</p></div>{auditIntegrity && <span className={`audit-integrity ${auditIntegrity.valid ? "valid" : "invalid"}`}>{auditIntegrity.valid ? "审计链完整" : "审计链校验失败"} · {auditIntegrity.checked_entries} 条</span>}</div>
      <div className="audit-table-head"><span>时间</span><span>事件</span><span>对象</span><span>标识</span><span>状态</span></div>
      {auditEntries.length ? auditEntries.map((row) => <div className="audit-table-row" key={row.audit_id}><span>{formatAuditTime(row.created_at)}</span><strong>{auditEventLabel(row.event_type)}</strong><span>{auditObjectLabel(row.object_type)}</span><code>{row.object_id}</code><Status status="已记录" /></div>) : <div className="audit-empty-state">当前组织尚无审计记录。</div>}
    </section>
  </section>;
}

function formatAuditTime(value) { return value ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : "—"; }
function auditEventLabel(eventType) { return ({ schema_confirmed: "Schema 确认", data_imported: "数据导入", output_schema_saved: "输出模板保存", output_field_rules_saved: "输出字段规则保存", temporary_fields_saved: "临时字段保存", global_logic_saved: "全局逻辑保存", calculation_completed: "核算完成", calculation_run_completed: "核算完成", payroll_foundation_schema_saved: "基础结构映射保存", configuration_version_saved: "配置版本保存", configuration_version_imported: "配置版本导入" })[eventType] || eventType; }
function auditObjectLabel(objectType) { return ({ data_page: "数据表", output_schema: "输出模板", output_field_rules: "输出字段规则", calculation_logic: "核算逻辑", organization_logic: "全局逻辑", calculation_run: "核算结果", configuration_version: "配置版本" })[objectType] || objectType; }
function PageHeading({ title, description, children }) {
  return (
    <div className="page-heading">
      <div>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {children && <div className="heading-actions">{children}</div>}
    </div>
  );
}
function Status({ status, label }) {
  return (
    <span
      className={`status ${status === "已发布" || status === "已导入" || status === "可执行" || status === "已完成" ? "positive" : ""}`}
    >
      <span />
      {label ? `${label}：${status}` : status}
    </span>
  );
}
createRoot(document.getElementById("root")).render(<App />);
