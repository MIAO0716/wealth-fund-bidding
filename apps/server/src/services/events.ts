import {
  DEFAULT_ALLOWED_INCREMENT_STEPS,
  DEFAULT_HIGH_VALUE_CONFIRM_PP,
  type EventConfig,
  type EventSummary,
  GROUPS,
  PROJECT_CODES,
  type ProjectCode,
  type ScreenMode,
  normalizeAllowedSteps,
} from '@bidding/shared';
import { z } from 'zod';
import type { Queryable, Tx } from '../db/pool';
import { uuid } from '../lib/crypto';
import { bizError } from '../lib/errors';
import { toIso } from '../lib/time';
import { type Actor, type EventRow, audit, emit } from './core';
import { type AppContext, runWrite } from './context';

export const DEFAULT_CONFIG: EventConfig = {
  name: '',
  year: null,
  eventDate: null,
  metricName: '',
  amountBasis: '',
  statPeriod: '',
  dataSource: '',
  // 二维码有效期内可重复扫码（同一时间一部手机在线）；默认 30 天有效，便于会前提前打印
  qrValidHours: 720,
  allowedIncrementSteps: [...DEFAULT_ALLOWED_INCREMENT_STEPS],
  highValueConfirmPp: DEFAULT_HIGH_VALUE_CONFIRM_PP,
  // 大屏默认展示底标与按增幅实时计算的目标金额
  showAmountsOnScreen: true,
  wifiSsid: '',
  wifiPassword: '',
};

const configPatchSchema = z
  .object({
    name: z.string().trim().max(100),
    year: z.number().int().min(2000).max(2100).nullable(),
    eventDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, '活动日期格式应为 YYYY-MM-DD')
      .nullable(),
    metricName: z.string().trim().max(100),
    amountBasis: z.string().trim().max(200),
    statPeriod: z.string().trim().max(200),
    dataSource: z.string().trim().max(500),
    qrValidHours: z.number().int().min(1).max(24 * 60),
    allowedIncrementSteps: z.array(z.number()),
    highValueConfirmPp: z.number().int().min(5).max(100000),
    showAmountsOnScreen: z.boolean(),
    wifiSsid: z.string().max(64),
    wifiPassword: z.string().max(64),
  })
  .partial()
  .strict();

export function parseConfigPatch(input: unknown): Partial<EventConfig> {
  const r = configPatchSchema.safeParse(input ?? {});
  if (!r.success) {
    throw bizError('BAD_REQUEST', r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('；'));
  }
  const patch = r.data as Partial<EventConfig>;
  // 年度随活动日期自动确定
  if (patch.eventDate) patch.year = Number(patch.eventDate.slice(0, 4));
  if (patch.allowedIncrementSteps !== undefined) {
    const steps = normalizeAllowedSteps(patch.allowedIncrementSteps);
    if (!steps) throw bizError('BAD_REQUEST', '快捷档位须为正整数，例如 [1,5,10]');
    patch.allowedIncrementSteps = steps;
  }
  return patch;
}

export function readConfig(row: { config: Record<string, unknown> }): EventConfig {
  return { ...DEFAULT_CONFIG, ...(row.config as Partial<EventConfig>) };
}

export function toSummary(row: EventRow & { parent_event_id: string | null; parent_reason: string | null; created_at: Date }): EventSummary {
  return {
    id: row.id,
    isDemo: row.is_demo,
    config: readConfig(row),
    currentProject: row.current_project,
    screenMode: row.screen_mode as ScreenMode,
    screenProject: row.screen_project,
    seq: Number(row.seq),
    draftVersion: row.draft_version,
    parentEventId: row.parent_event_id,
    parentReason: row.parent_reason,
    createdAt: toIso(row.created_at)!,
  };
}

export async function getEventRow(q: Queryable, eventId: string) {
  if (!/^[0-9a-f-]{36}$/i.test(eventId)) throw bizError('NOT_FOUND', '活动不存在');
  const r = await q.query('SELECT * FROM events WHERE id = $1', [eventId]);
  if (!r.rowCount) throw bizError('NOT_FOUND', '活动不存在');
  return r.rows[0];
}

/** 正式开启前必须具备的配置（只需活动名称与日期）；返回缺失项说明（空数组表示齐全） */
export function configProblems(config: EventConfig): string[] {
  const p: string[] = [];
  if (!config.name) p.push('未填写活动名称');
  if (!config.eventDate) p.push('未填写活动日期');
  if (!normalizeAllowedSteps(config.allowedIncrementSteps)) p.push('快捷档位配置不合法');
  return p;
}

export interface CreateEventInput {
  isDemo?: boolean;
  config?: unknown;
  parentEventId?: string | null;
  parentReason?: string | null;
}

/** 新建活动：两个项目、各三组、草稿 32 条（底标与首轮均为未填写） */
export async function createEvent(ctx: AppContext, actor: Actor, input: CreateEventInput): Promise<string> {
  if (ctx.config.readOnly) throw bizError('READ_ONLY');
  const patch = parseConfigPatch(input.config ?? {});
  const config: EventConfig = { ...DEFAULT_CONFIG, ...patch };
  const id = uuid();
  const client = await ctx.db.connect();
  try {
    await client.query('BEGIN');
    if (input.parentEventId) {
      const parent = await client.query('SELECT id FROM events WHERE id = $1', [input.parentEventId]);
      if (!parent.rowCount) throw bizError('NOT_FOUND', '关联的原活动不存在');
    }
    await client.query(
      `INSERT INTO events (id, is_demo, config, parent_event_id, parent_reason, created_by)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, !!input.isDemo, JSON.stringify(config), input.parentEventId ?? null, input.parentReason?.trim() || null, actor.type === 'ADMIN' ? actor.id : null],
    );
    await initProjects(client, id);
    await audit(client, id, actor, 'EVENT_CREATED', {
      reason: input.parentReason ?? null,
      details: { isDemo: !!input.isDemo, parentEventId: input.parentEventId ?? null },
    });
    await client.query('COMMIT');
    return id;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

async function initProjects(tx: Tx, eventId: string): Promise<void> {
  for (const p of PROJECT_CODES) {
    await tx.query('INSERT INTO projects (event_id, project_code) VALUES ($1, $2)', [eventId, p]);
    for (const g of GROUPS) {
      await tx.query(
        'INSERT INTO project_groups (event_id, project_code, group_no, min_increase_pp) VALUES ($1, $2, $3, $4)',
        [eventId, p, g.groupNo, g.minIncreasePp],
      );
    }
    await tx.query(
      `INSERT INTO first_round_drafts (event_id, project_code, unit_code)
       SELECT $1, $2, code FROM units ORDER BY display_order`,
      [eventId, p],
    );
  }
}

export async function updateConfig(ctx: AppContext, eventId: string, actor: Actor, input: unknown) {
  const patch = parseConfigPatch(input);
  return runWrite(ctx, eventId, actor, { operation: 'UPDATE_CONFIG' }, async (tx, ev) => {
    const before = readConfig(ev);
    const after: EventConfig = { ...before, ...patch };
    await tx.query('UPDATE events SET config = $2 WHERE id = $1', [eventId, JSON.stringify(after)]);
    const changed = Object.keys(patch).filter(
      (k) => JSON.stringify((before as never)[k]) !== JSON.stringify((after as never)[k]),
    );
    const seq = await emit(tx, eventId, { type: 'EVENT_UPDATED', audience: 'PUBLIC', data: { changed } });
    await audit(tx, eventId, actor, 'CONFIG_UPDATED', {
      details: { changed, before: pick(before, changed), after: pick(after, changed) },
      eventSequence: seq,
    });
    return { body: { config: after } };
  });
}

function pick(obj: object, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of keys) out[k] = (obj as Record<string, unknown>)[k];
  return out;
}

export async function setScreenMode(
  ctx: AppContext,
  eventId: string,
  actor: Actor,
  input: { mode?: unknown; projectCode?: unknown },
) {
  const mode = input.mode;
  if (mode !== 'FIRST_ROUND' && mode !== 'LIVE' && mode !== 'RESULTS') throw bizError('BAD_REQUEST', '大屏模式不合法');
  const projectCode = input.projectCode;
  if (projectCode !== 'wealth' && projectCode !== 'fund') throw bizError('BAD_REQUEST', '项目代码不合法');
  return runWrite(ctx, eventId, actor, { operation: 'SCREEN_MODE' }, async (tx) => {
    await tx.query('UPDATE events SET screen_mode = $2, screen_project = $3 WHERE id = $1', [eventId, mode, projectCode]);
    const seq = await emit(tx, eventId, {
      type: 'SCREEN_MODE',
      audience: 'PUBLIC',
      projectCode: projectCode as ProjectCode,
      data: { mode, projectCode },
    });
    await audit(tx, eventId, actor, 'SCREEN_MODE', { projectCode: projectCode as ProjectCode, details: { mode }, eventSequence: seq });
    return { body: { mode, projectCode } };
  });
}

export async function listEvents(q: Queryable): Promise<EventSummary[]> {
  const r = await q.query('SELECT * FROM events WHERE NOT archived ORDER BY created_at DESC');
  return r.rows.map(toSummary);
}

export async function archiveEvent(ctx: AppContext, eventId: string, actor: Actor) {
  return runWrite(ctx, eventId, actor, { operation: 'ARCHIVE' }, async (tx, ev) => {
    if (!ev.is_demo) throw bizError('DEMO_ONLY', '正式活动不能归档删除；如需重来请新建关联活动');
    await tx.query('UPDATE events SET archived = true WHERE id = $1', [eventId]);
    await audit(tx, eventId, actor, 'EVENT_ARCHIVED');
    return { body: { archived: true } };
  });
}
