'use strict';

/**
 * Electron Forge 打包配置（npm run package / npm run make）
 *
 * 注意：Node v26.3.0 下 extract-zip/yauzl 有"解压中途静默退出"的 bug，
 * 已由 scripts/patch-extract-zip.js（npm postinstall 自动重放）改用系统 unzip 修复。
 */
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
  makers: [
    {
      // 产出 out/make/zip/linux-x64/dsh-desktop-linux-x64-<version>.zip
      name: '@electron-forge/maker-zip',
      platforms: ['linux'],
    },
  ],
};
