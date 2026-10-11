-- 金山文档接入：领导在金山文档中填写，本机程序定时读取并按同一套规则处理

-- 来源增加「金山文档」
ALTER TABLE bid_records DROP CONSTRAINT bid_records_source_check;
ALTER TABLE bid_records ADD CONSTRAINT bid_records_source_check CHECK (source IN ('LEADER', 'ADMIN_PROXY', 'KDOCS'));
ALTER TABLE bid_states DROP CONSTRAINT bid_states_base_ack_source_check;
ALTER TABLE bid_states ADD CONSTRAINT bid_states_base_ack_source_check CHECK (base_ack_source IN ('LEADER', 'ADMIN_PROXY', 'KDOCS'));

-- 每个活动绑定一个金山表格（脚本 webhook 链接 + 脚本令牌）
CREATE TABLE kdocs_bindings (
  event_id       uuid PRIMARY KEY REFERENCES events(id),
  webhook_url    text NOT NULL,
  token          text NOT NULL,
  interval_sec   integer NOT NULL DEFAULT 3 CHECK (interval_sec BETWEEN 1 AND 60),
  max_rows       integer NOT NULL DEFAULT 40 CHECK (max_rows BETWEEN 5 AND 200),
  enabled        boolean NOT NULL DEFAULT false,
  -- 首次开启同步时，表格中已填写的行标记为「开始同步前已填写」，不参与竞标
  baseline_done  boolean NOT NULL DEFAULT false,
  enabled_at     timestamptz,
  updated_at     timestamptz NOT NULL DEFAULT now()
);

-- 已处理的报价行：每行只处理一次，之后的修改无效
CREATE TABLE kdocs_rows (
  event_id       uuid NOT NULL REFERENCES events(id),
  unit_code      text NOT NULL REFERENCES units(code),
  row_no         integer NOT NULL,
  target_raw     text,
  confirm_raw    text,
  status         text NOT NULL CHECK (status IN ('APPLIED', 'REJECTED', 'PREEXISTING')),
  project_code   text,
  from_pp        integer,
  to_pp          integer,
  receipt_no     text,
  message        text NOT NULL,
  first_seen_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (event_id, unit_code, row_no)
);
