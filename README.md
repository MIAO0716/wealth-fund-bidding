# 理财、基金现场竞标系统

上海市分公司 16 家区分公司理财、基金两个项目的现场竞标系统：领导手机 H5 竞标端 + 电脑实时大屏 + 工作人员管理端。

- 需求与验收说明：[docs/需求与验收说明.md](docs/需求与验收说明.md)
- 接口说明：[docs/接口说明.md](docs/接口说明.md)
- 界面设计规范：[docs/设计规范.md](docs/设计规范.md)

## 开发进度

| 稿次 | 内容 | 状态 |
| --- | --- | --- |
| 第一稿 | 数据与规则：数据库、认证、首轮导入（JSON/CSV/Excel/手动）、发布冻结、状态机、加码事务、幂等、审计、实时事件与 SSE、自动化测试 | ✅ 已完成 |
| 第二稿 | 现场界面：领导手机端、首轮大屏、实时大屏、结果大屏、管理端，SSE 断线恢复与轮询降级；真实多浏览器 E2E | ✅ 已完成 |
| 第三稿 | 正式使用准备：Excel 导出、备份恢复、Docker 部署、现场操作手册、验收场景全量跑测 | 进行中 |

## 技术结构

- 前端 React + TypeScript + Vite（`apps/web`），系统字体、无外部 CDN 依赖
- 后端 Node.js + TypeScript + Fastify（`apps/server`）
- 数据库 PostgreSQL（`apps/server/migrations`）
- 共享规则、类型、错误码（`packages/shared`）：前后端共用，后端独立校验，不依赖前端

单进程、同域部署，服务端权威计算。所有写操作在活动行锁下串行执行，保证加码、锁定、组别开闭之间的事务先后关系；
实时事件写入数据库 outbox 表并带全局递增序列，推送、断线补发、服务重启后都以数据库为准。

## 本地开发

需要 Node.js ≥ 22.9、PostgreSQL ≥ 14。

```bash
# 1. 安装依赖（已锁定版本，见 package-lock.json）
npm ci

# 2. 准备数据库（示例）
createuser -P bid            # 设置密码
createdb -O bid bidding
createdb -O bid bidding_test # 测试库，会被测试清空

# 3. 配置
cp .env.example .env         # 修改 DATABASE_URL、PUBLIC_BASE_URL 等

# 4. 建表并创建管理员（密码交互输入，不落盘）
npm run db:migrate
npm run admin:create -- --username admin --name 工作人员

# 5. 启动后端（开发模式，自动重载，默认 8080 端口）
npm run dev:server

# 6. 另开终端启动前端开发服务器（5173 端口，/api 自动代理到 8080）
npm run dev:web
```

浏览器打开 `http://localhost:5173/admin` 登录管理端。手机联调时把 `.env` 中 `PUBLIC_BASE_URL` 设为电脑的局域网地址（如 `http://192.168.1.10:5173`），二维码才能在手机上打开。

## 页面与角色

| 页面 | 地址 | 谁使用 | 进入方式 |
| --- | --- | --- | --- |
| 管理端 | `/admin` | 工作人员 | 账号密码登录 |
| 领导手机端 | `/join` → `/bid` | 16 家单位领导 | 扫描专属二维码（一次性凭证，扫码后绑定该手机） |
| 大屏（跟随管理端切换） | `/screen` | 投屏电脑 | 管理端「二维码与大屏」生成的只读链接 |
| 首轮大屏 / 实时大屏 / 结果大屏 | `/screen/first-round`、`/screen/live`、`/screen/results`（可加 `?project=wealth`） | 投屏电脑 | 同上，打开过大屏链接后可直接访问 |

界面截图（E2E 自动生成）：

| 实时大屏 | 首轮大屏 | 结果大屏 |
| --- | --- | --- |
| ![实时大屏](docs/screenshots/screen-live.png) | ![首轮大屏](docs/screenshots/screen-first-round.png) | ![结果大屏](docs/screenshots/screen-results.png) |

| 手机端 | 二次确认 | 管理端 |
| --- | --- | --- |
| ![手机端](docs/screenshots/phone-bid.png) | ![二次确认](docs/screenshots/phone-confirm.png) | ![管理端](docs/screenshots/admin-control.png) |

## 测试

```bash
npm test          # 规则单元测试 + 服务端集成测试（真实 PostgreSQL）
npm run typecheck
npm run build && npm run test:e2e   # 真实多浏览器全流程（需 E2E 库 bidding_e2e，会被清空）
```

E2E 使用 Playwright，同时打开 5 个互相独立的浏览器会话：管理端（1440×900）、大屏（1920×1080）、浦东/闵行/黄浦三部手机（390×844），
走完「发布首轮 → 认领底标 → 开组 → 手机两步确认加码 → 大屏同步 → 结束三组自动暂停 → 锁定 → 结果大屏 → 发布基金」全流程，
并检查手机无横向溢出、大屏 16 家完整可见。第二稿实测：手机点击确认到大屏显示新增幅约 150–170 毫秒（本机）。
如本机 Chromium 不在默认位置，设置 `CHROMIUM_PATH` 指向浏览器可执行文件。

测试使用 `TEST_DATABASE_URL`（默认 `postgres://bid:bid@localhost:5432/bidding_test`），每个测试文件开始时会清空该库。

第一稿实际执行结果：4 个测试文件、61 个用例全部通过，覆盖验收场景 A01–A23 中与服务端相关的部分：

| 范围 | 用例 |
| --- | --- |
| 金额/步长/排名规则 | 精确到分、不复利、5 的倍数、允许档位、1-1-3 并列、30% 门槛 |
| 导入 | A01–A06：待录入、组别门槛、行级报错整批拒绝、32 条项目隔离、草稿保密、版本与幂等、Excel/CSV/GBK 解析 |
| 加码 | A07–A16：发布冻结、+5/+10、仅 +5 配置、篡改请求、首轮与实时分离、同单位并发只成功一次、幂等重放、响应丢失后回执核验、锁定与加码竞态、暂停/非当前组/底标未确认 |
| 权限 | A17：会话绑定单位、请求体单位被忽略、一次性凭证、旧会话失效、跨站请求头 |
| 流程 | A18–A20、A23：先理财后基金、锁定须先暂停、控制版本、单组开放、标王/并列/组内领先、管理员代录 |
| 实时 | A21–A22：SSE 1 秒内到达、权限裁剪、断线按序补发无重复、序列超前重新同步、服务重启数据完整 |

## 数据与安全要点

- 金额以人民币分 `bigint` 存储，接口传十进制字符串；增幅存整数百分点；时间存 UTC，界面按 Asia/Shanghai 显示。
- 首轮快照、加码流水、结果快照由数据库触发器禁止修改和删除；`bid_states` 触发器禁止下调当前增幅。
- 凭证与会话只存 SHA-256 哈希；二维码凭证放在 URL `#` 片段中，不进入服务器日志；日志脱敏 Cookie。
- 正式活动初始化为「未填写/未录入」，不生成任何正式数值；演示活动单独创建并在所有页面标注「演示」。

## 演示与正式隔离

- `POST /api/v1/admin/events` 带 `{"isDemo": true}` 创建演示活动，自动填充演示数据。
- 正式活动不能填充演示数据，也不能被删除或清空；发布后如发现基础数据错误，新建一场关联原活动的新活动并注明原因。
