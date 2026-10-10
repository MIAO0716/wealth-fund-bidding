-- 理财、基金现场竞标系统：初始结构
-- 金额一律以人民币「分」的 bigint 存储；增幅以整数百分点存储（35 表示 35%）；时间为 UTC timestamptz。

CREATE TABLE admins (
  id            uuid PRIMARY KEY,
  username      text NOT NULL UNIQUE,
  display_name  text NOT NULL,
  password_hash text NOT NULL,
  disabled      boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE units (
  code          text PRIMARY KEY,
  name          text NOT NULL UNIQUE,
  group_no      smallint NOT NULL CHECK (group_no IN (1, 2, 3)),
  display_order smallint NOT NULL UNIQUE
);

CREATE TABLE events (
  id               uuid PRIMARY KEY,
  is_demo          boolean NOT NULL DEFAULT false,
  config           jsonb NOT NULL,
  current_project  text NOT NULL DEFAULT 'wealth' CHECK (current_project IN ('wealth', 'fund')),
  screen_mode      text NOT NULL DEFAULT 'FIRST_ROUND' CHECK (screen_mode IN ('FIRST_ROUND', 'LIVE', 'RESULTS')),
  screen_project   text NOT NULL DEFAULT 'wealth' CHECK (screen_project IN ('wealth', 'fund')),
  -- 活动内全局递增序列，用于实时事件补发
  seq              bigint NOT NULL DEFAULT 0,
  -- 首轮草稿全局版本（任一项目草稿变更都会递增）
  draft_version    integer NOT NULL DEFAULT 0,
  parent_event_id  uuid REFERENCES events(id),
  parent_reason    text,
  archived         boolean NOT NULL DEFAULT false,
  created_by       uuid REFERENCES admins(id),
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE projects (
  event_id         uuid NOT NULL REFERENCES events(id),
  project_code     text NOT NULL CHECK (project_code IN ('wealth', 'fund')),
  status           text NOT NULL DEFAULT 'DRAFT'
                   CHECK (status IN ('DRAFT', 'ROUND1_PUBLISHED', 'LIVE', 'PAUSED', 'LOCKED')),
  draft_version    integer NOT NULL DEFAULT 0,
  control_version  integer NOT NULL DEFAULT 0,
  current_group    smallint CHECK (current_group IN (1, 2, 3)),
  first_round_snapshot_id uuid,
  result_snapshot_id      uuid,
  published_at     timestamptz,
  started_at       timestamptz,
  locked_at        timestamptz,
  PRIMARY KEY (event_id, project_code)
);

CREATE TABLE project_groups (
  event_id         uuid NOT NULL,
  project_code     text NOT NULL,
  group_no         smallint NOT NULL CHECK (group_no IN (1, 2, 3)),
  min_increase_pp  integer NOT NULL,
  status           text NOT NULL DEFAULT 'WAITING' CHECK (status IN ('WAITING', 'OPEN', 'CLOSED')),
  opened_at        timestamptz,
  closed_at        timestamptz,
  PRIMARY KEY (event_id, project_code, group_no),
  FOREIGN KEY (event_id, project_code) REFERENCES projects(event_id, project_code)
);

-- 每个项目同时最多一个开放组
CREATE UNIQUE INDEX project_groups_one_open ON project_groups (event_id, project_code) WHERE status = 'OPEN';

CREATE TABLE first_round_drafts (
  event_id          uuid NOT NULL,
  project_code      text NOT NULL,
  unit_code         text NOT NULL REFERENCES units(code),
  base_target_fen   bigint CHECK (base_target_fen > 0),
  first_round_pp    integer CHECK (first_round_pp > 0 AND first_round_pp % 5 = 0),
  remark            text,
  last_batch_id     uuid,
  updated_at        timestamptz,
  updated_by        uuid REFERENCES admins(id),
  PRIMARY KEY (event_id, project_code, unit_code),
  FOREIGN KEY (event_id, project_code) REFERENCES projects(event_id, project_code)
);

CREATE TABLE import_batches (
  id                uuid PRIMARY KEY,
  event_id          uuid NOT NULL REFERENCES events(id),
  source            text NOT NULL CHECK (source IN ('JSON', 'CSV', 'XLSX', 'MANUAL')),
  file_name         text,
  mode              text NOT NULL DEFAULT 'upsert',
  status            text NOT NULL CHECK (status IN ('VALIDATED', 'INVALID', 'COMMITTED')),
  content_hash      text NOT NULL,
  draft_version     integer NOT NULL,
  rows              jsonb NOT NULL,
  result            jsonb NOT NULL,
  admin_id          uuid NOT NULL REFERENCES admins(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  expires_at        timestamptz NOT NULL,
  committed_at      timestamptz,
  committed_version integer
);

-- 首轮发布快照：不可变
CREATE TABLE first_round_snapshots (
  id               uuid PRIMARY KEY,
  event_id         uuid NOT NULL,
  project_code     text NOT NULL,
  batch_no         text NOT NULL,
  draft_version    integer NOT NULL,
  published_at     timestamptz NOT NULL,
  published_by     uuid NOT NULL REFERENCES admins(id),
  UNIQUE (event_id, project_code),
  FOREIGN KEY (event_id, project_code) REFERENCES projects(event_id, project_code)
);

CREATE TABLE first_round_snapshot_rows (
  snapshot_id      uuid NOT NULL REFERENCES first_round_snapshots(id),
  unit_code        text NOT NULL REFERENCES units(code),
  base_target_fen  bigint NOT NULL CHECK (base_target_fen > 0),
  first_round_pp   integer NOT NULL,
  remark           text,
  PRIMARY KEY (snapshot_id, unit_code)
);

-- 当前竞标状态（发布首轮时初始化）
CREATE TABLE bid_states (
  event_id          uuid NOT NULL,
  project_code      text NOT NULL,
  unit_code         text NOT NULL REFERENCES units(code),
  base_target_fen   bigint NOT NULL CHECK (base_target_fen > 0),
  first_round_pp    integer NOT NULL,
  current_pp        integer NOT NULL,
  version           integer NOT NULL DEFAULT 0,
  base_ack_at       timestamptz,
  base_ack_source   text CHECK (base_ack_source IN ('LEADER', 'ADMIN_PROXY')),
  base_ack_actor    text,
  base_ack_reason   text,
  updated_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (event_id, project_code, unit_code),
  FOREIGN KEY (event_id, project_code) REFERENCES projects(event_id, project_code),
  CHECK (current_pp >= first_round_pp)
);

-- 加码流水：只追加
CREATE TABLE bid_records (
  id               uuid PRIMARY KEY,
  receipt_no       text NOT NULL,
  event_id         uuid NOT NULL,
  project_code     text NOT NULL,
  unit_code        text NOT NULL REFERENCES units(code),
  from_pp          integer NOT NULL,
  to_pp            integer NOT NULL CHECK (to_pp > from_pp),
  delta_pp         integer NOT NULL CHECK (delta_pp > 0 AND delta_pp % 5 = 0),
  base_target_fen  bigint NOT NULL,
  target_fen       bigint NOT NULL,
  source           text NOT NULL CHECK (source IN ('LEADER', 'ADMIN_PROXY')),
  actor_type       text NOT NULL,
  actor_id         text NOT NULL,
  reason           text,
  bid_version      integer NOT NULL,
  event_sequence   bigint NOT NULL,
  idempotency_key  text NOT NULL,
  accepted_at      timestamptz NOT NULL,
  FOREIGN KEY (event_id, project_code) REFERENCES projects(event_id, project_code),
  UNIQUE (event_id, project_code, unit_code, bid_version),
  UNIQUE (event_id, receipt_no)
);
CREATE INDEX bid_records_event_seq ON bid_records (event_id, event_sequence);

-- 项目锁定时的最终结果快照：不可变
CREATE TABLE result_snapshots (
  id               uuid PRIMARY KEY,
  event_id         uuid NOT NULL,
  project_code     text NOT NULL,
  locked_at        timestamptz NOT NULL,
  locked_by        uuid NOT NULL REFERENCES admins(id),
  event_sequence   bigint NOT NULL,
  groups           jsonb NOT NULL,
  tie_warnings     jsonb NOT NULL,
  UNIQUE (event_id, project_code),
  FOREIGN KEY (event_id, project_code) REFERENCES projects(event_id, project_code)
);

CREATE TABLE result_snapshot_rows (
  snapshot_id      uuid NOT NULL REFERENCES result_snapshots(id),
  unit_code        text NOT NULL REFERENCES units(code),
  group_no         smallint NOT NULL,
  base_target_fen  bigint NOT NULL,
  first_round_pp   integer NOT NULL,
  final_pp         integer NOT NULL,
  target_fen       bigint NOT NULL,
  rank             integer NOT NULL,
  is_top           boolean NOT NULL,
  leader_label     text NOT NULL,
  bid_version      integer NOT NULL,
  PRIMARY KEY (snapshot_id, unit_code)
);

-- 幂等记录：主体作用域 + 幂等键唯一
CREATE TABLE idempotency_records (
  scope            text NOT NULL,
  idem_key         text NOT NULL,
  operation        text NOT NULL,
  request_hash     text NOT NULL,
  status_code      integer NOT NULL,
  response         jsonb NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (scope, idem_key)
);

CREATE TABLE audit_logs (
  id               bigserial PRIMARY KEY,
  event_id         uuid REFERENCES events(id),
  project_code     text,
  unit_code        text,
  action           text NOT NULL,
  actor_type       text NOT NULL,
  actor_id         text,
  actor_name       text,
  reason           text,
  details          jsonb NOT NULL DEFAULT '{}'::jsonb,
  event_sequence   bigint,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_event ON audit_logs (event_id, id);

-- 失败提交记录（用于监控）
CREATE TABLE failed_submissions (
  id               bigserial PRIMARY KEY,
  event_id         uuid,
  project_code     text,
  unit_code        text,
  actor_type       text NOT NULL,
  actor_id         text,
  operation        text NOT NULL,
  error_code       text NOT NULL,
  message          text,
  created_at       timestamptz NOT NULL DEFAULT now()
);

-- 持久实时事件（outbox），用于推送与断线补发
CREATE TABLE realtime_events (
  event_id         uuid NOT NULL REFERENCES events(id),
  seq              bigint NOT NULL,
  type             text NOT NULL,
  project_code     text,
  unit_code        text,
  -- PUBLIC：大屏/领导/管理员均可（领导端只收项目级消息）
  -- SCREEN：大屏与管理员，以及 unit_code 对应的单位
  -- UNIT：仅 unit_code 对应的单位与管理员
  -- ADMIN：仅管理员
  audience         text NOT NULL CHECK (audience IN ('PUBLIC', 'SCREEN', 'UNIT', 'ADMIN')),
  data             jsonb NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (event_id, seq)
);

-- 二维码一次性交换凭证（只存哈希）
CREATE TABLE unit_credentials (
  id               uuid PRIMARY KEY,
  event_id         uuid NOT NULL REFERENCES events(id),
  unit_code        text NOT NULL REFERENCES units(code),
  token_hash       text NOT NULL UNIQUE,
  expires_at       timestamptz NOT NULL,
  used_at          timestamptz,
  revoked_at       timestamptz,
  created_by       uuid REFERENCES admins(id),
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX unit_credentials_unit ON unit_credentials (event_id, unit_code);

-- 大屏只读凭证（可多块屏共用，可撤销）
CREATE TABLE screen_keys (
  id               uuid PRIMARY KEY,
  event_id         uuid NOT NULL REFERENCES events(id),
  label            text NOT NULL,
  token_hash       text NOT NULL UNIQUE,
  revoked_at       timestamptz,
  created_by       uuid REFERENCES admins(id),
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  id               uuid PRIMARY KEY,
  token_hash       text NOT NULL UNIQUE,
  role             text NOT NULL CHECK (role IN ('BIDDER', 'SCREEN', 'ADMIN')),
  event_id         uuid REFERENCES events(id),
  unit_code        text REFERENCES units(code),
  admin_id         uuid REFERENCES admins(id),
  credential_id    uuid,
  expires_at       timestamptz NOT NULL,
  revoked_at       timestamptz,
  revoke_reason    text,
  user_agent       text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  last_seen_at     timestamptz NOT NULL DEFAULT now(),
  CHECK ((role = 'BIDDER') = (unit_code IS NOT NULL)),
  CHECK ((role = 'ADMIN') = (admin_id IS NOT NULL))
);
CREATE INDEX sessions_unit ON sessions (event_id, unit_code) WHERE role = 'BIDDER';

CREATE TABLE maintenance_log (
  id               bigserial PRIMARY KEY,
  action           text NOT NULL,
  details          jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at       timestamptz NOT NULL DEFAULT now()
);

-- 固定 16 家单位
INSERT INTO units (code, name, group_no, display_order) VALUES
  ('PD', '浦东', 1, 1), ('MH', '闵行', 1, 2), ('BS', '宝山', 1, 3), ('JD', '嘉定', 1, 4),
  ('FX', '奉贤', 1, 5), ('SJ', '松江', 1, 6),
  ('HP', '黄浦', 2, 7), ('HK', '虹口', 2, 8), ('JA', '静安', 2, 9), ('PT', '普陀', 2, 10), ('CN', '长宁', 2, 11),
  ('XH', '徐汇', 3, 12), ('YP', '杨浦', 3, 13), ('QP', '青浦', 3, 14), ('JS', '金山', 3, 15), ('CM', '崇明', 3, 16);

-- 不可变表：禁止 UPDATE / DELETE
CREATE FUNCTION forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '表 % 只允许追加，禁止修改或删除', TG_TABLE_NAME;
END;
$$;

CREATE TRIGGER first_round_snapshots_immutable BEFORE UPDATE OR DELETE ON first_round_snapshots
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER first_round_snapshot_rows_immutable BEFORE UPDATE OR DELETE ON first_round_snapshot_rows
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER result_snapshots_immutable BEFORE UPDATE OR DELETE ON result_snapshots
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER result_snapshot_rows_immutable BEFORE UPDATE OR DELETE ON result_snapshot_rows
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER bid_records_immutable BEFORE UPDATE OR DELETE ON bid_records
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- 只增不减：数据库层兜底，当前增幅不能下调
CREATE FUNCTION bid_states_no_decrease() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.current_pp < OLD.current_pp THEN
    RAISE EXCEPTION '当前增幅不能下调（% → %）', OLD.current_pp, NEW.current_pp;
  END IF;
  IF NEW.base_target_fen <> OLD.base_target_fen OR NEW.first_round_pp <> OLD.first_round_pp THEN
    RAISE EXCEPTION '首轮快照数据发布后不可修改';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER bid_states_guard BEFORE UPDATE ON bid_states
  FOR EACH ROW EXECUTE FUNCTION bid_states_no_decrease();
