/** 前后端共享的接口数据结构。金额一律为十进制字符串。 */

import type { GroupNo, ProjectCode } from './units';
import type { GroupStatus, LeaderStatus, ProjectStatus } from './rules';

export interface EventConfig {
  name: string;
  year: number | null;
  /** 活动日期 YYYY-MM-DD（Asia/Shanghai） */
  eventDate: string | null;
  /** 业务指标名称，例如「理财销量」 */
  metricName: string;
  /** 金额统计口径，例如「销量」或「AUM净增」——由组织者填写 */
  amountBasis: string;
  /** 统计周期 */
  statPeriod: string;
  /** 数据来源说明 */
  dataSource: string;
  /** 二维码有效小时数 */
  qrValidHours: number;
  /** 手机与代录的快捷档位（百分点）；每次加码可以是任意正整数 */
  allowedIncrementSteps: number[];
  /** 增幅达到此值时需再次明确确认（不是上限） */
  highValueConfirmPp: number;
  /** 首轮大屏是否展示底标与目标金额 */
  showAmountsOnScreen: boolean;
  /** 会场 Wi-Fi 名称（填写后领导使用卡上印「扫码连 Wi-Fi」二维码；可留空） */
  wifiSsid: string;
  /** 会场 Wi-Fi 密码（开放网络留空） */
  wifiPassword: string;
}

export type ScreenMode = 'FIRST_ROUND' | 'LIVE' | 'RESULTS';

export interface EventSummary {
  id: string;
  isDemo: boolean;
  config: EventConfig;
  currentProject: ProjectCode;
  screenMode: ScreenMode;
  screenProject: ProjectCode;
  seq: number;
  draftVersion: number;
  parentEventId: string | null;
  parentReason: string | null;
  createdAt: string;
}

export interface GroupView {
  groupNo: GroupNo;
  name: string;
  minIncreasePp: number;
  status: GroupStatus;
}

export interface ProjectView {
  projectCode: ProjectCode;
  name: string;
  status: ProjectStatus;
  draftVersion: number;
  controlVersion: number;
  currentGroup: GroupNo | null;
  publishedAt: string | null;
  lockedAt: string | null;
  groups: GroupView[];
}

/** 实时榜的一行 */
export interface LiveRow {
  unitCode: string;
  unitName: string;
  groupNo: GroupNo;
  displayOrder: number;
  firstRoundPp: number;
  currentPp: number;
  rank: number | null;
  isTop: boolean;
  bidVersion: number;
  baseAcknowledged: boolean;
  /** 仅在允许展示金额时返回 */
  baseTargetWan?: string;
  targetWan?: string;
}

export interface GroupBoard {
  groupNo: GroupNo;
  name: string;
  minIncreasePp: number;
  status: GroupStatus;
  leaderStatus: LeaderStatus;
  topPp: number | null;
  topUnitCodes: string[];
  rows: LiveRow[];
}

export interface BidFeedItem {
  bidId: string;
  receiptNo: string;
  unitCode: string;
  unitName: string;
  projectCode: ProjectCode;
  fromPp: number;
  toPp: number;
  source: 'LEADER' | 'ADMIN_PROXY' | 'KDOCS';
  acceptedAt: string;
  eventSequence: number;
}

export interface BidReceipt {
  bidId: string;
  receiptNo: string;
  unitCode: string;
  projectCode: ProjectCode;
  fromPp: number;
  toPp: number;
  deltaPp: number;
  baseTargetWan: string;
  targetWan: string;
  targetFen: string;
  bidVersion: number;
  eventSequence: number;
  acceptedAt: string;
  source: 'LEADER' | 'ADMIN_PROXY' | 'KDOCS';
}

export interface FirstRoundRow {
  unitCode: string;
  unitName: string;
  groupNo: GroupNo;
  displayOrder: number;
  firstRoundPp: number | null;
  rank: number | null;
  baseTargetWan?: string | null;
  targetWan?: string | null;
  remark?: string | null;
}

export interface FirstRoundGroup {
  groupNo: GroupNo;
  name: string;
  minIncreasePp: number;
  rows: FirstRoundRow[];
}

export interface FirstRoundBoard {
  projectCode: ProjectCode;
  published: boolean;
  publishedAt: string | null;
  snapshotId: string | null;
  completeCount: number;
  totalCount: number;
  groups: FirstRoundGroup[];
}

export type RealtimeType =
  | 'BID_ACCEPTED'
  | 'BASE_ACKNOWLEDGED'
  | 'PROJECT_STATUS'
  | 'GROUP_STATUS'
  | 'FIRST_ROUND_PUBLISHED'
  | 'PROJECT_LOCKED'
  | 'DRAFT_UPDATED'
  | 'EVENT_UPDATED'
  | 'SCREEN_MODE'
  | 'SESSION_CHANGED';

export interface RealtimeMessage {
  seq: number;
  type: RealtimeType;
  projectCode: ProjectCode | null;
  unitCode: string | null;
  serverTime: string;
  data: Record<string, unknown>;
}

export interface ImportRowInput {
  projectCode?: unknown;
  unitCode?: unknown;
  unitName?: unknown;
  baseTargetWan?: unknown;
  firstRoundIncreasePp?: unknown;
  remark?: unknown;
}

export interface ImportRowResult {
  index: number;
  /** 原文件中的行号（CSV/Excel），JSON 为 index+1 */
  sourceRow: number;
  status: 'OK' | 'ERROR';
  action: 'CREATE' | 'UPDATE' | 'UNCHANGED' | null;
  errors: string[];
  projectCode: ProjectCode | null;
  unitCode: string | null;
  unitName: string | null;
  baseTargetWan: string | null;
  firstRoundIncreasePp: number | null;
  previewTargetWan: string | null;
  previous: { baseTargetWan: string | null; firstRoundIncreasePp: number | null } | null;
  remark: string | null;
}

export interface ImportValidationResult {
  validationId: string | null;
  valid: boolean;
  expiresAt: string | null;
  draftVersion: number;
  contentHash: string;
  rows: ImportRowResult[];
  summary: { total: number; ok: number; errors: number; creates: number; updates: number; unchanged: number };
  completenessAfter: Record<ProjectCode, { complete: number; total: number }>;
}
