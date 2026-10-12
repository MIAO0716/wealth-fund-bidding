-- 2027 年一季度方案 6.0：每次加码为 1 的整数倍（组内自由加码）；首轮增幅也只要求是正整数百分点。
-- 原约束要求 5 的整数倍，改为正整数（列本身是 integer，已保证是整数）。
ALTER TABLE first_round_drafts DROP CONSTRAINT IF EXISTS first_round_drafts_first_round_pp_check;
ALTER TABLE first_round_drafts ADD CONSTRAINT first_round_drafts_first_round_pp_check CHECK (first_round_pp > 0);
ALTER TABLE bid_records DROP CONSTRAINT IF EXISTS bid_records_delta_pp_check;
ALTER TABLE bid_records ADD CONSTRAINT bid_records_delta_pp_check CHECK (delta_pp > 0);
