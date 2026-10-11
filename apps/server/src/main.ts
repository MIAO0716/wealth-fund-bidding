import { buildApp } from './app';
import { loadConfig } from './config';
import { migrate } from './db/migrate';

const config = loadConfig();
const { app, hub, db, kdocs } = await buildApp(config);

await migrate(db, undefined, (m) => app.log.info(m));
await hub.start();
await app.listen({ host: config.host, port: config.port });
await kdocs.sync.start();
app.log.info(`对外地址（二维码使用）：${config.publicBaseUrl}${config.readOnly ? '（只读维护模式）' : ''}`);

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    app.log.info(`收到 ${sig}，正在关闭`);
    app.close().then(() => process.exit(0));
  });
}
