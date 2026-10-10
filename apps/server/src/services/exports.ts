/**
 * 导出：.xlsx（四个工作表）与各表 CSV。
 * - 最终竞标台账取自锁定结果快照；未锁定项目取当前状态并明显标注「过程数据」。
 * - 百分比单元格存小数（0.35）并以 0% 格式显示；金额单位万元。
 * - 文本防 Excel 公式注入；不包含任何凭证或会话信息。
 */

import { GROUPS, PROJECT_CODES, PROJECT_NAMES, type ProjectCode, UNITS, UNIT_BY_CODE, fenToWanExact, targetFen } from '@bidding/shared';
import ExcelJS from 'exceljs';
import type { Tx } from '../db/pool';
import { formatShanghai } from '../lib/time';
import { computeResults } from './projects';
import { readConfig } from './events';


const ACTION_NAMES: Record<string, string> = {
  FIRST_ROUND_PUBLISHED: '首轮发布',
  PROJECT_STARTED: '开始竞标',
  PROJECT_PAUSED: '暂停',
  PROJECT_RESUMED: '恢复',
  PROJECT_AUTO_PAUSED: '最后一组结束自动暂停',
  GROUP_OPENED: '开放组别',
  GROUP_REOPENED: '重新开放组别',
  GROUP_CLOSED: '结束组别',
  PROJECT_LOCKED: '项目锁定',
  BASE_ACK: '领导确认认领底标',
  BASE_ACK_PROXY: '工作人员代记底标确认',
};

/** 防公式注入：以 = + - @ 制表符 回车 开头的文本前加单引号 */
export function safeText(v: unknown): string {
  const s = v === null || v === undefined ? '' : String(v);
  return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
}

const wanNum = (fen: bigint | string) => Number(fenToWanExact(BigInt(fen)));

interface Col {
  header: string;
  key: string;
  width: number;
  kind?: 'text' | 'pct' | 'wan' | 'int' | 'time';
}

export interface Sheet {
  name: string;
  cols: Col[];
  rows: Record<string, unknown>[];
}

export interface ExportData {
  title: string;
  provisional: boolean;
  generatedAt: Date;
  sheets: Sheet[];
}

export async function collectExport(tx: Tx, eventId: string): Promise<ExportData> {
  const ev = (await tx.query('SELECT * FROM events WHERE id = $1', [eventId])).rows[0];
  const cfg = readConfig(ev);
  const projects = (await tx.query('SELECT * FROM projects WHERE event_id = $1', [eventId])).rows;
  const byProject = new Map(projects.map((p) => [p.project_code as ProjectCode, p]));
  const provisional = projects.some((p) => p.status !== 'LOCKED');
  const groupName = (n: number) => GROUPS.find((g) => g.groupNo === n)!.name;

  // 1. 首轮结果（仅已发布快照）
  const first: Record<string, unknown>[] = [];
  for (const pc of PROJECT_CODES) {
    const p = byProject.get(pc)!;
    if (!p.first_round_snapshot_id) continue;
    const snap = (await tx.query('SELECT * FROM first_round_snapshots WHERE id = $1', [p.first_round_snapshot_id])).rows[0];
    const rows = (await tx.query('SELECT * FROM first_round_snapshot_rows WHERE snapshot_id = $1', [snap.id])).rows;
    const map = new Map(rows.map((r) => [r.unit_code, r]));
    for (const u of UNITS) {
      const r = map.get(u.code)!;
      first.push({
        project: PROJECT_NAMES[pc],
        group: groupName(u.groupNo),
        unit: u.name,
        base: wanNum(r.base_target_fen),
        firstPp: r.first_round_pp,
        firstTarget: wanNum(targetFen(BigInt(r.base_target_fen), r.first_round_pp)),
        batch: snap.batch_no,
        publishedAt: formatShanghai(snap.published_at),
      });
    }
  }

  // 2. 最终竞标台账
  const ledger: Record<string, unknown>[] = [];
  for (const pc of PROJECT_CODES) {
    const p = byProject.get(pc)!;
    if (p.status === 'DRAFT') continue;
    if (p.status === 'LOCKED') {
      const snap = (await tx.query('SELECT * FROM result_snapshots WHERE id = $1', [p.result_snapshot_id])).rows[0];
      const rows = (await tx.query('SELECT * FROM result_snapshot_rows WHERE snapshot_id = $1', [snap.id])).rows;
      const groupsMeta = new Map((snap.groups as Array<{ groupNo: number; leaderStatus: string }>).map((g) => [g.groupNo, g]));
      rows.sort((a, b) => a.group_no - b.group_no || a.rank - b.rank || UNIT_BY_CODE.get(a.unit_code)!.displayOrder - UNIT_BY_CODE.get(b.unit_code)!.displayOrder);
      for (const r of rows) {
        ledger.push({
          project: PROJECT_NAMES[pc],
          group: groupName(r.group_no),
          unit: UNIT_BY_CODE.get(r.unit_code)!.name,
          base: wanNum(r.base_target_fen),
          firstPp: r.first_round_pp,
          finalPp: r.final_pp,
          addedPp: r.final_pp - r.first_round_pp,
          finalTarget: wanNum(r.target_fen),
          rank: r.rank,
          status: r.is_top ? r.leader_label || leaderText(groupsMeta.get(r.group_no)?.leaderStatus) : '',
          lockedAt: formatShanghai(snap.locked_at),
          dataType: '锁定结果',
        });
      }
    } else {
      const states = (await tx.query('SELECT * FROM bid_states WHERE event_id = $1 AND project_code = $2', [eventId, pc])).rows;
      const { groups, byUnit } = computeResults(states);
      for (const g of groups) {
        for (const r of g.ranking.rows) {
          const s = byUnit.get(r.unitCode)!;
          ledger.push({
            project: PROJECT_NAMES[pc],
            group: groupName(g.groupNo),
            unit: UNIT_BY_CODE.get(r.unitCode)!.name,
            base: wanNum(s.base_target_fen),
            firstPp: s.first_round_pp,
            finalPp: s.current_pp,
            addedPp: s.current_pp - s.first_round_pp,
            finalTarget: wanNum(targetFen(BigInt(s.base_target_fen), s.current_pp)),
            rank: r.rank,
            status: r.isTop ? leaderText(g.ranking.leaderStatus) : '',
            lockedAt: '',
            dataType: '过程数据（未锁定）',
          });
        }
      }
    }
  }

  // 3. 加码流水
  const bids = (await tx.query('SELECT * FROM bid_records WHERE event_id = $1 ORDER BY event_sequence', [eventId])).rows;
  const flow = bids.map((b) => ({
    receipt: b.receipt_no,
    project: PROJECT_NAMES[b.project_code as ProjectCode],
    unit: UNIT_BY_CODE.get(b.unit_code)!.name,
    fromPp: b.from_pp,
    toPp: b.to_pp,
    deltaPp: b.delta_pp,
    target: wanNum(b.target_fen),
    at: formatShanghai(b.accepted_at),
    source: b.source === 'ADMIN_PROXY' ? '工作人员代录' : '领导提交',
    reason: b.reason ?? '',
  }));

  // 4. 确认与控制记录
  const logs = (
    await tx.query(
      `SELECT * FROM audit_logs WHERE event_id = $1 AND action = ANY($2) ORDER BY id`,
      [eventId, Object.keys(ACTION_NAMES)],
    )
  ).rows;
  const control = logs.map((l) => ({
    at: formatShanghai(l.created_at),
    action: ACTION_NAMES[l.action] ?? l.action,
    project: l.project_code ? PROJECT_NAMES[l.project_code as ProjectCode] : '',
    unit: l.unit_code ? UNIT_BY_CODE.get(l.unit_code)?.name ?? l.unit_code : '',
    detail: l.details?.groupNo ? `第${l.details.groupNo}组` : l.details?.batchNo ?? '',
    actor: l.actor_name ?? '',
    reason: l.reason ?? '',
  }));

  return {
    title: `${cfg.name || '现场竞标'}${ev.is_demo ? '（演示）' : ''}`,
    provisional,
    generatedAt: new Date(),
    sheets: [
      {
        name: '首轮结果',
        cols: [
          { header: '项目', key: 'project', width: 8 },
          { header: '组别', key: 'group', width: 8 },
          { header: '单位', key: 'unit', width: 8 },
          { header: '基础底标（万元）', key: 'base', width: 16, kind: 'wan' },
          { header: '首轮增幅', key: 'firstPp', width: 10, kind: 'pct' },
          { header: '首轮目标（万元）', key: 'firstTarget', width: 16, kind: 'wan' },
          { header: '发布批次', key: 'batch', width: 22 },
          { header: '发布时间', key: 'publishedAt', width: 20 },
        ],
        rows: first,
      },
      {
        name: '最终竞标台账',
        cols: [
          { header: '项目', key: 'project', width: 8 },
          { header: '组别', key: 'group', width: 8 },
          { header: '单位', key: 'unit', width: 8 },
          { header: '基础底标（万元）', key: 'base', width: 16, kind: 'wan' },
          { header: '首轮增幅', key: 'firstPp', width: 10, kind: 'pct' },
          { header: '最终增幅', key: 'finalPp', width: 10, kind: 'pct' },
          { header: '现场累计加码（百分点）', key: 'addedPp', width: 20, kind: 'int' },
          { header: '最终目标（万元）', key: 'finalTarget', width: 16, kind: 'wan' },
          { header: '组内排名', key: 'rank', width: 10, kind: 'int' },
          { header: '标王门槛/并列状态', key: 'status', width: 26 },
          { header: '锁定时间', key: 'lockedAt', width: 20 },
          { header: '数据性质', key: 'dataType', width: 18 },
        ],
        rows: ledger,
      },
      {
        name: '加码流水',
        cols: [
          { header: '回执', key: 'receipt', width: 20 },
          { header: '项目', key: 'project', width: 8 },
          { header: '单位', key: 'unit', width: 8 },
          { header: '原增幅', key: 'fromPp', width: 10, kind: 'pct' },
          { header: '新增幅', key: 'toPp', width: 10, kind: 'pct' },
          { header: '追加（百分点）', key: 'deltaPp', width: 14, kind: 'int' },
          { header: '目标金额（万元）', key: 'target', width: 16, kind: 'wan' },
          { header: '操作时间', key: 'at', width: 20 },
          { header: '来源', key: 'source', width: 14 },
          { header: '代录原因', key: 'reason', width: 30 },
        ],
        rows: flow,
      },
      {
        name: '确认与控制记录',
        cols: [
          { header: '时间', key: 'at', width: 20 },
          { header: '操作', key: 'action', width: 22 },
          { header: '项目', key: 'project', width: 8 },
          { header: '单位', key: 'unit', width: 8 },
          { header: '说明', key: 'detail', width: 22 },
          { header: '操作主体', key: 'actor', width: 16 },
          { header: '原因', key: 'reason', width: 30 },
        ],
        rows: control,
      },
    ],
  };
}

function leaderText(status: string | undefined): string {
  if (status === 'CHAMPION_CANDIDATE') return '标王候选（≥30%）';
  if (status === 'TIED_PENDING') return '并列第一·授旗规则待确认';
  if (status === 'GROUP_LEADER') return '组内领先（未达30%门槛）';
  return '';
}

export async function toXlsx(data: ExportData): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = '现场竞标系统';
  wb.created = data.generatedAt;
  for (const sheet of data.sheets) {
    const ws = wb.addWorksheet(sheet.name, { views: [{ state: 'frozen', ySplit: 2 }] });
    const banner = `${data.title} · ${sheet.name} · 导出时间 ${formatShanghai(data.generatedAt)}${data.provisional ? ' · 【过程数据：存在未锁定项目，不作为最终公示】' : ' · 最终公示台账（取自锁定快照）'}`;
    const titleRow = ws.addRow([banner]);
    titleRow.font = { bold: true, color: { argb: data.provisional ? 'FFB7791F' : 'FF7A0C18' } };
    ws.mergeCells(1, 1, 1, sheet.cols.length);
    const header = ws.addRow(sheet.cols.map((c) => c.header));
    header.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    header.eachCell((cell) => {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFC8102E' } };
      cell.alignment = { vertical: 'middle' };
    });
    sheet.cols.forEach((c, i) => {
      ws.getColumn(i + 1).width = c.width;
    });
    for (const r of sheet.rows) {
      const row = ws.addRow(
        sheet.cols.map((c) => {
          const v = r[c.key];
          if (v === null || v === undefined || v === '') return null;
          if (c.kind === 'pct') return Number(v) / 100;
          if (c.kind === 'wan' || c.kind === 'int') return Number(v);
          return safeText(v);
        }),
      );
      sheet.cols.forEach((c, i) => {
        const cell = row.getCell(i + 1);
        if (c.kind === 'pct') cell.numFmt = '0%';
        else if (c.kind === 'wan') cell.numFmt = '#,##0.00';
        else if (c.kind === 'int') cell.numFmt = '0';
      });
    }
  }
  return Buffer.from((await wb.xlsx.writeBuffer()) as ArrayBuffer);
}

function csvCell(v: string): string {
  return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

export function toCsv(data: ExportData, sheetName: string): Buffer | null {
  const sheet = data.sheets.find((s) => s.name === sheetName);
  if (!sheet) return null;
  const lines = [sheet.cols.map((c) => c.header).join(',')];
  for (const r of sheet.rows) {
    lines.push(
      sheet.cols
        .map((c) => {
          const v = r[c.key];
          if (v === null || v === undefined) return '';
          if (c.kind === 'pct') return `${v}%`;
          if (c.kind === 'wan') return Number(v).toFixed(2);
          return csvCell(safeText(v));
        })
        .join(','),
    );
  }
  const note = data.provisional ? '过程数据：存在未锁定项目，不作为最终公示' : '最终公示台账（取自锁定快照）';
  return Buffer.from(`﻿# ${data.title} · ${sheet.name} · ${formatShanghai(data.generatedAt)} · ${note}\r\n${lines.join('\r\n')}\r\n`, 'utf8');
}
