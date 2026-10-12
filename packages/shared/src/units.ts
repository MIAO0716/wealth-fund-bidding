/** 固定参赛单位、组别与项目。单位代码用于接口与权限绑定，名称只用于展示。 */

export type ProjectCode = 'wealth' | 'fund';
export type GroupNo = 1 | 2 | 3;

export interface UnitDef {
  code: string;
  name: string;
  groupNo: GroupNo;
  displayOrder: number;
}

export interface GroupDef {
  groupNo: GroupNo;
  name: string;
  minIncreasePp: number;
}

export const PROJECT_CODES: readonly ProjectCode[] = ['wealth', 'fund'];

export const PROJECT_NAMES: Record<ProjectCode, string> = {
  wealth: '理财',
  fund: '基金',
};

/** 项目先后顺序：先理财后基金 */
export const PROJECT_ORDER: Record<ProjectCode, number> = { wealth: 1, fund: 2 };

export const GROUPS: readonly GroupDef[] = [
  { groupNo: 1, name: '第一组', minIncreasePp: 10 },
  { groupNo: 2, name: '第二组', minIncreasePp: 10 },
  { groupNo: 3, name: '第三组', minIncreasePp: 10 },
];

const RAW_UNITS: Array<[string, string, GroupNo]> = [
  ['PD', '浦东', 1],
  ['MH', '闵行', 1],
  ['BS', '宝山', 1],
  ['JD', '嘉定', 1],
  ['FX', '奉贤', 1],
  ['SJ', '松江', 1],
  ['HP', '黄浦', 2],
  ['HK', '虹口', 2],
  ['JA', '静安', 2],
  ['PT', '普陀', 2],
  ['CN', '长宁', 2],
  ['XH', '徐汇', 3],
  ['YP', '杨浦', 3],
  ['QP', '青浦', 3],
  ['JS', '金山', 3],
  ['CM', '崇明', 3],
];

export const UNITS: readonly UnitDef[] = RAW_UNITS.map(([code, name, groupNo], i) => ({
  code,
  name,
  groupNo,
  displayOrder: i + 1,
}));

export const UNIT_BY_CODE: ReadonlyMap<string, UnitDef> = new Map(UNITS.map((u) => [u.code, u]));

export const GROUP_BY_NO: ReadonlyMap<number, GroupDef> = new Map(GROUPS.map((g) => [g.groupNo, g]));

export function isProjectCode(v: unknown): v is ProjectCode {
  return v === 'wealth' || v === 'fund';
}

/** 中文项目名或代码 → 项目代码；不认识返回 null */
export function parseProjectCode(v: unknown): ProjectCode | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (s === 'wealth' || s === '理财') return 'wealth';
  if (s === 'fund' || s === '基金') return 'fund';
  return null;
}

export function unitsOfGroup(groupNo: number): UnitDef[] {
  return UNITS.filter((u) => u.groupNo === groupNo);
}

export function groupMinPp(groupNo: number): number {
  const g = GROUP_BY_NO.get(groupNo);
  if (!g) throw new Error(`未知组别 ${groupNo}`);
  return g.minIncreasePp;
}
