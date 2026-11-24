import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

import { build } from 'esbuild';

const require = createRequire(import.meta.url);
const { inject } = require('postject');

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const buildDir = path.join(root, 'build');
const bundle = path.join(buildDir, 'flowget.cjs');
const blob = path.join(buildDir, 'flowget.blob');
const exe = path.join(buildDir, 'FlowGet.exe');
const seaConfig = path.join(buildDir, 'sea-config.json');

await fsp.rm(buildDir, { recursive: true, force: true });
await fsp.mkdir(buildDir, { recursive: true });

console.log('打包服务端…');
await build({
  entryPoints: [path.join(root, 'src', 'server.js')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node24',
  outfile: bundle,
  minify: false,
  sourcemap: false,
  legalComments: 'none',
  logOverride: { 'empty-import-meta': 'silent' },
  define: { 'import.meta.url': 'undefined' }
});

console.log('生成 SEA 配置…');
await fsp.writeFile(seaConfig, JSON.stringify({
  main: bundle,
  output: blob,
  disableExperimentalSEAWarning: true,
  useSnapshot: false,
  useCodeCache: false,
  assets: {
    'index.html': path.join(root, 'public', 'index.html'),
    'app.js': path.join(root, 'public', 'app.js'),
    'style.css': path.join(root, 'public', 'style.css'),
    'favicon.svg': path.join(root, 'public', 'favicon.svg')
  }
}, null, 2));

console.log('生成 SEA blob…');
execFileSync(process.execPath, ['--experimental-sea-config', seaConfig], { stdio: 'inherit' });

console.log('复制 Node 运行时…');
fs.copyFileSync(process.execPath, exe);

try {
  execFileSync('signtool', ['remove', '/s', exe], { stdio: 'ignore' });
} catch {
  // 没有签名工具时跳过，未签名的 Node 二进制本身也能注入。
}

console.log('注入 SEA blob…');
await inject(exe, 'NODE_SEA_BLOB', fs.readFileSync(blob), {
  sentinelFuse: 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
  overwrite: true
});

const size = fs.statSync(exe).size;
console.log(`完成 ${exe}`);
console.log(`大小 ${(size / 1024 / 1024).toFixed(1)} MB`);
