// 生产构建：把服务端与共享包打成单个 ESM 文件，node_modules 依赖保持外部引用
import { build } from 'esbuild';

await build({
  entryPoints: { main: 'src/main.ts', migrate: 'src/cli/migrate.ts', 'admin-create': 'src/cli/admin-create.ts' },
  outdir: 'dist',
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  packages: 'external',
  // @bidding/shared 是工作区源码，需要打包进来
  plugins: [
    {
      name: 'bundle-workspace',
      setup(b) {
        b.onResolve({ filter: /^@bidding\/shared$/ }, () => ({ path: new URL('../../../packages/shared/src/index.ts', import.meta.url).pathname }));
      },
    },
  ],
  sourcemap: true,
  logLevel: 'info',
});
