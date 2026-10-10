/** 生成仓库内的空白首轮数据模板（32 行，不含任何数值）：npm run templates */
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { templateCsv, templateXlsx } from '../services/templates';

const dir = process.argv[2] ?? join(process.cwd(), '..', '..', 'templates');
await writeFile(join(dir, '首轮数据模板.xlsx'), await templateXlsx());
await writeFile(join(dir, '首轮数据模板.csv'), templateCsv());
console.log(`已生成空白模板到 ${dir}`);
