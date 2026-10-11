-- 每家单位一个金山文档文件（各单位互相看不到）：单位代码 → 文件链接；为空表示一个文件 16 张工作表
ALTER TABLE kdocs_bindings ADD COLUMN unit_files jsonb;
