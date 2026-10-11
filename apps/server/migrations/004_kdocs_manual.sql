-- 金山文档默认改为手动读取：工作人员看到表格有变化时点「读取金山表格」，避免频繁调用金山文档
ALTER TABLE kdocs_bindings ADD COLUMN auto_sync boolean NOT NULL DEFAULT false;
