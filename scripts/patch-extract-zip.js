'use strict';

/**
 * 本机环境补丁（npm postinstall 自动重放）
 *
 * 问题：Node v26.3.0 下 extract-zip/yauzl 解压大 zip（electron 二进制包）时，
 * 会在中途静默清空事件循环，导致进程以 exit 0 "成功"退出、解压不完整，
 * electron-forge package 因此永远卡在 "Finalizing package" 且无产物。
 *
 * 方案：用系统 unzip 重写 extract-zip 的入口实现（对外接口保持不变）。
 * 注意：该补丁只作用于本机 node_modules，每次 npm install 后由 postinstall 重放。
 */

const fs = require('fs');
const path = require('path');

const PATCH = [
  "'use strict';",
  '// patched by scripts/patch-extract-zip.js (Node v26.3.0 yauzl silent-exit workaround)',
  'const { execFile } = require(\'child_process\');',
  'module.exports = function extractZip(zipPath, opts) {',
  '  const dir = (opts && opts.dir) || process.cwd();',
  '  return new Promise((resolve, reject) => {',
  '    execFile(\'unzip\', [\'-o\', \'-q\', zipPath, \'-d\', dir], { maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {',
  '      if (err) { err.message = \'unzip failed: \' + err.message + (stderr ? \'\\n\' + stderr : \'\'); return reject(err); }',
  '      resolve();',
  '    });',
  '  });',
  '};',
  '',
].join('\n');

const targets = [
  path.join(__dirname, '..', 'node_modules', 'extract-zip', 'index.js'),
  path.join(__dirname, '..', 'node_modules', '@electron-internal', 'extract-zip', 'index.js'),
];

let patched = 0;
for (const t of targets) {
  if (fs.existsSync(t)) {
    fs.writeFileSync(t, PATCH);
    patched++;
    console.log('[dsh-desktop] extract-zip 补丁已应用:', path.relative(process.cwd(), t));
  }
}
if (patched === 0) console.log('[dsh-desktop] 未找到 extract-zip（依赖未安装？），跳过补丁');
