# 组织存储隔离规格

每个组织必须使用独立目录，并按用途划分 `databases/`、`config/`、`python/`、`results/` 和 `packages/` 子目录。配置阶段只访问 `databases/configuration.db`；真实业务数据、导入批次、计算运行和结果表只写入 `databases/business_data.db`。

真实业务文件的结构预检由本地 Python 流式读取有限行完成，不调用 AI；正式导入才逐行读取全部数据。每个导入批次必须保存已确认 Schema 的指纹，计算前必须再次核对当前配置指纹。旧版 `organization.db` 在首次打开时迁移到双数据库，原文件保留为可恢复的旧库副本。

AI 只能使用配置结构和规则元数据，不得获得 `business_data.db` 连接、真实业务行或结果样例行。导出结果统一写入组织的 `results/`，已确认 Python 代码按规则类型同步到组织的 `python/`。
