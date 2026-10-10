/** 演示活动：与正式活动隔离（events.is_demo），所有页面标注「演示」。正式活动永远不会被填入演示数据。 */

import { GROUP_BY_NO, PROJECT_CODES, UNITS } from '@bidding/shared';
import { bizError } from '../lib/errors';
import { type Actor, audit, emit } from './core';
import { type AppContext, runWrite } from './context';
import { createEvent } from './events';

/** 确定性的演示数值：底标 50–300 万元，首轮增幅为组别底线 + 0–15 */
function demoValues(projectIdx: number, unitIdx: number, groupNo: number) {
  const base = 50 + ((unitIdx * 37 + projectIdx * 53) % 251);
  const cents = ((unitIdx * 13 + projectIdx * 7) % 100).toString().padStart(2, '0');
  const min = GROUP_BY_NO.get(groupNo)!.minIncreasePp;
  const pp = min + 5 * ((unitIdx + projectIdx * 2) % 4);
  return { baseFen: BigInt(base) * 1_000_000n + BigInt(cents) * 10_000n, pp };
}

export async function createDemoEvent(ctx: AppContext, actor: Actor) {
  const today = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
  const id = await createEvent(ctx, actor, {
    isDemo: true,
    config: {
      name: '【演示】理财、基金现场竞标',
      year: Number(today.slice(0, 4)),
      eventDate: today,
      metricName: '演示指标（非正式口径）',
      amountBasis: '演示口径',
      statPeriod: '演示周期',
      dataSource: '系统生成的演示数据，非正式数据',
    },
  });
  await seedDemo(ctx, id, actor);
  return id;
}

export async function seedDemo(ctx: AppContext, eventId: string, actor: Actor) {
  return runWrite(ctx, eventId, actor, { operation: 'DEMO_SEED' }, async (tx, ev) => {
    if (!ev.is_demo) throw bizError('DEMO_ONLY', '正式活动不能填充演示数据');
    let n = 0;
    for (const [pi, p] of PROJECT_CODES.entries()) {
      const status = (await tx.query('SELECT status FROM projects WHERE event_id = $1 AND project_code = $2', [eventId, p])).rows[0].status;
      if (status !== 'DRAFT') continue;
      for (const [ui, u] of UNITS.entries()) {
        const v = demoValues(pi, ui, u.groupNo);
        await tx.query(
          `UPDATE first_round_drafts SET base_target_fen = $4, first_round_pp = $5, remark = '演示数据', updated_at = now(), updated_by = $6
            WHERE event_id = $1 AND project_code = $2 AND unit_code = $3`,
          [eventId, p, u.code, v.baseFen.toString(), v.pp, actor.id],
        );
        n++;
      }
      await tx.query('UPDATE projects SET draft_version = draft_version + 1 WHERE event_id = $1 AND project_code = $2', [eventId, p]);
    }
    await tx.query('UPDATE events SET draft_version = draft_version + 1 WHERE id = $1', [eventId]);
    const seq = await emit(tx, eventId, { type: 'DRAFT_UPDATED', audience: 'ADMIN', data: { demo: true, rows: n } });
    await audit(tx, eventId, actor, 'DEMO_SEEDED', { details: { rows: n }, eventSequence: seq });
    return { body: { rows: n } };
  });
}
