-- 1. 删除活动：只有在同一事务内显式声明「删除整个活动」时，才允许清理只追加的快照与流水表
CREATE OR REPLACE FUNCTION forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND coalesce(current_setting('bidding.purge', true), '') = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION '表 % 只允许追加，禁止修改或删除', TG_TABLE_NAME;
END;
$$;

-- 2. 领导二维码活动期间固定不变：保存凭证原文，管理端可随时再次显示、打印同一个二维码
ALTER TABLE unit_credentials ADD COLUMN IF NOT EXISTS token text;
