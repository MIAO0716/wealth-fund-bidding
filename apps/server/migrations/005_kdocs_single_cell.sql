-- 极简版式（领导只填「我要加到」一个格子）：处理后程序清空该格子。
-- cleared 记录清空指令是否已送达金山表格；程序重启后只对未送达的那一条补发（条件）清空，
-- 不会误清领导之后重新填写的同一个数字。旧记录视为已清空。
ALTER TABLE kdocs_rows ADD COLUMN cleared boolean NOT NULL DEFAULT true;
