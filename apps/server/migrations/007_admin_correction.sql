-- 管理端更正：现场领导误操作时，工作人员可在锁定前把增幅下调（不低于首轮增幅）。
-- 只有更正流水允许下调；领导提交、代录、金山文档仍然只增不减。

ALTER TABLE bid_records DROP CONSTRAINT IF EXISTS bid_records_source_check;
ALTER TABLE bid_records ADD CONSTRAINT bid_records_source_check
  CHECK (source IN ('LEADER', 'ADMIN_PROXY', 'KDOCS', 'ADMIN_CORRECTION'));

ALTER TABLE bid_records DROP CONSTRAINT IF EXISTS bid_records_check;
ALTER TABLE bid_records DROP CONSTRAINT IF EXISTS bid_records_delta_pp_check;
ALTER TABLE bid_records ADD CONSTRAINT bid_records_direction_check CHECK (
  (source = 'ADMIN_CORRECTION' AND to_pp < from_pp AND delta_pp = to_pp - from_pp)
  OR (source <> 'ADMIN_CORRECTION' AND to_pp > from_pp AND delta_pp > 0)
);

-- 数据库兜底：只有在同一事务内显式声明「管理端更正」时才允许下调
CREATE OR REPLACE FUNCTION bid_states_no_decrease() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.current_pp < OLD.current_pp AND coalesce(current_setting('bidding.correction', true), '') <> 'on' THEN
    RAISE EXCEPTION '当前增幅不能下调（% → %）', OLD.current_pp, NEW.current_pp;
  END IF;
  IF NEW.base_target_fen <> OLD.base_target_fen OR NEW.first_round_pp <> OLD.first_round_pp THEN
    RAISE EXCEPTION '首轮快照数据发布后不可修改';
  END IF;
  RETURN NEW;
END;
$$;
