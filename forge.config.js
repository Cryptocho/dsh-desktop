'use strict';

/**
 * Electron Forge 打包配置（npm run package / npm run make）
 *
 * 注意：Node v26.3.0 下 extract-zip/yauzl 有"解压中途静默退出"的 bug，
 * 已由 scripts/patch-extract-zip.js（npm postinstall 自动重放）改用系统 unzip 修复。
 */
const path = require('path');
const fs = require('fs');

module.exports = {
  packagerConfig: {
    name: 'dsh-desktop',
    executableName: 'dsh-desktop',
    asar: true,
    ignore: [
      /^\/out($|\/)/,
      /^\/\.git($|\/)/,
      /^\/scripts($|\/)/,
    ],
  },
  hooks: {
    // 打包后把图标以散文件形式复制进 resources/icons/（asar 外），
    // zip 产物里可直接取用，方便 ebuild 安装 hicolor 图标与 .desktop
    postPackage: async (_forgeConfig, options) => {
      const outputPaths = options.outputPaths || [options.outputPath];
      for (const appDir of outputPaths) {
        const destDir = path.join(appDir, 'resources', 'icons');
        fs.mkdirSync(destDir, { recursive: true });
        for (const f of ['tray.png', 'icon.png']) {
          fs.copyFileSync(path.join(__dirname, 'assets', f), path.join(destDir, f));
        }
        console.log(`[forge] 已复制图标到 ${destDir}`);
      }
    },
  },
  makers: [
    {
      // 产出 out/make/zip/linux-x64/dsh-desktop-linux-x64-<version>.zip
      name: '@electron-forge/maker-zip',
      platforms: ['linux'],
    },
  ],
};
