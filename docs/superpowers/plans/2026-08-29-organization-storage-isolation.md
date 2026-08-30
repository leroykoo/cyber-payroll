# Organization Storage Isolation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将每个组织改造成分类目录下的配置库与业务库双数据库架构，并保证真实数据仅由本地 Python 流式处理。

**Architecture:** 保留 `OrganizationDatabase` 作为调用方门面，新增 `connect_config()` 与 `connect_data()`，使现有配置接口保持稳定，同时明确业务数据连接。首次打开旧组织时按表类型复制到两个新数据库并保留旧库副本；导入批次记录 Schema 指纹，计算前核对指纹。

**Tech Stack:** Python 3、SQLite、React/Vite、本地 HTTP API、openpyxl

**Spec:** `docs/specs/organization-storage-isolation.md`

## Global Constraints

- 所有组织数据必须保存在 `organizations/<organization_id>/` 内。
- 前期配置和 AI 辅助不得读取真实业务行。
- 不删除旧数据库；迁移必须可恢复。
- 按项目约定只修改代码并做静态检查，不编译、不运行测试、不启动服务。

---

### Task 1: 组织目录和双数据库门面

**Files:**
- Modify: `backend/payroll_app/organization_db.py`
- Modify: `backend/payroll_app/registry.py`

**Interfaces:**
- Produces: `OrganizationDatabase.connect_config()`、`connect_data()`、`configuration_db_path`、`business_db_path`、`python_dir`、`results_dir`。

- [ ] 创建 `databases/`、`config/`、`python/`、`results/`、`packages/`。
- [ ] 分别初始化配置表和业务元数据表。
- [ ] 保留 `connect()` 作为配置库兼容别名。
- [ ] 让组织创建接口从一开始生成完整目录。

### Task 2: 旧数据库安全迁移

**Files:**
- Modify: `backend/payroll_app/organization_db.py`

**Interfaces:**
- Consumes: 旧 `organization.db`。
- Produces: `databases/configuration.db`、`databases/business_data.db`、迁移标记与旧库副本。

- [ ] 将固定配置表复制到配置库。
- [ ] 将 `import_batches`、`calculation_runs` 和动态业务/结果表复制到业务库。
- [ ] 迁移成功后把旧库移动为 `databases/legacy_organization.db`，不删除。
- [ ] 重复初始化保持幂等，不重复覆盖新库。

### Task 3: 配置与业务读写拆分

**Files:**
- Modify: `backend/payroll_app/organization_db.py`
- Modify: `backend/payroll_app/data_importer.py`
- Modify: `backend/payroll_app/local_api.py`

**Interfaces:**
- Consumes: `connect_config()`、`connect_data()`。
- Produces: 配置页面只访问配置库，导入批次与业务表只访问业务库。

- [ ] 数据页、字段、规则、配置版本和审计改用配置库。
- [ ] 真实导入、导入批次、计算运行和结果上下文改用业务库。
- [ ] 跨库操作采用“业务事务提交后写配置审计”的顺序。
- [ ] 组织创建响应返回两个数据库路径和分类目录。

### Task 4: 流式导入和 Schema 指纹

**Files:**
- Modify: `backend/payroll_app/data_importer.py`
- Modify: `backend/payroll_app/organization_db.py`
- Modify: `backend/payroll_app/calculation_engine.py`

**Interfaces:**
- Produces: `schema_fingerprint(page_name)`；`import_batches.schema_hash`；计算前结构一致性检查。

- [ ] 用已确认 Schema 的稳定 JSON 生成 SHA-256 指纹。
- [ ] 正式导入逐行处理，不再执行 `list(self._rows(...))`。
- [ ] 导入批次保存指纹和严格结构校验结果。
- [ ] 计算前逐表比对最新批次指纹与当前配置，发现不一致立即停止。

### Task 5: Python 代码和结果文件分类

**Files:**
- Modify: `backend/payroll_app/organization_db.py`
- Modify: `backend/payroll_app/calculation_engine.py`
- Modify: `backend/payroll_app/excel_exporter.py`
- Modify: `backend/payroll_app/model_package.py`

**Interfaces:**
- Produces: `python/global/`、`python/temporary/`、`python/output/` 和 `results/`。

- [ ] 保存规则时将已确认代码同步为独立 `.py` 文件。
- [ ] 结果表保存在业务库，结果 Excel 写入 `results/`。
- [ ] Excel 导出同时使用配置库中的输出结构和业务库中的结果行。
- [ ] 模型包写入组织 `packages/`。

### Task 6: 静态一致性检查和文档

**Files:**
- Modify: `backend/payroll_app/README.md`
- Inspect: `backend/payroll_app/*.py`

**Interfaces:**
- Produces: 架构说明和验证边界记录。

- [ ] 搜索并分类所有 `.connect()` 调用，确认没有业务表走配置连接。
- [ ] 搜索旧目录名和 `organization.db`，确认仅保留迁移兼容用途。
- [ ] 更新目录树、隐私边界、迁移行为和恢复方式说明。
- [ ] 不运行编译或测试，并在交付中明确说明。
