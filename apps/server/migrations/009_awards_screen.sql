-- 大屏新增「标王颁奖」模式
ALTER TABLE events DROP CONSTRAINT IF EXISTS events_screen_mode_check;
ALTER TABLE events ADD CONSTRAINT events_screen_mode_check CHECK (screen_mode IN ('FIRST_ROUND', 'LIVE', 'RESULTS', 'AWARDS'));
