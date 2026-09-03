'use strict';

/**
 * dsh-desktop —— 极简 Electron 壳
 *
 * 启动流程:
 *   1. 探测 http://localhost:3080 是否已有 DSH Web 服务
 *      - 已就绪  -> 直接开窗口（关闭时弹窗提示：不会关闭该服务）
 *      - 未就绪  -> 依次尝试启动:
 *          a) PATH 中的 `dsh web --no-open`
 *          b) `npx @deepseek-ai/dsh web --no-open`
 *          c) 均失败 -> 弹错误对话框并退出
 *   2. 服务就绪后，在窗口中加载该页面
 *   3. 本程序启动的 dsh 与本程序生命周期一致：退出时终止整个进程树
 *
 * 环境变量（均可选）:
 *   DSH_DESKTOP_PORT               目标端口，默认 3080
 *   DSH_DESKTOP_READY_TIMEOUT_MS   等待服务就绪的超时，默认 120000
 */

const { app, BrowserWindow, Menu, dialog, shell } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');

// ---------------- 配置 ----------------

const PORT = Number(process.env.DSH_DESKTOP_PORT || 3080);
const BASE_URL = `http://localhost:${PORT}`;
const READY_TIMEOUT_MS = Number(process.env.DSH_DESKTOP_READY_TIMEOUT_MS || 120000);
const POLL_INTERVAL_MS = 500;
const IS_WIN = process.platform === 'win32';

// ---------------- 运行状态 ----------------

let win = null;
let dsh = null; // 本程序启动的 dsh 子进程；null 表示使用外部已就绪的服务
let via = null; // 实际使用的启动方式描述
let quitting = false;
let dshStoppedByUs = false;
let childError = null;
let childExit = null;
let stderrTail = '';

// ---------------- 工具函数 ----------------

function log(...args) {
  console.log('[dsh-desktop]', ...args);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** 探测端口上是否有 HTTP 服务在响应（任何状态码都算就绪） */
function pingPort() {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: '/', timeout: 2000 }, (res) => {
      res.resume();
      resolve(true);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function waitReady(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (childError || childExit) return false; // 进程已失败/退出，不再傻等
    if (await pingPort()) return true;
    await sleep(POLL_INTERVAL_MS);
  }
  return false;
}

/** 手动扫描 PATH 查找 dsh 可执行文件，返回绝对路径或 null */
function findDshOnPath() {
  const dirs = (process.env.PATH || '').split(IS_WIN ? ';' : ':').filter(Boolean);
  const exts = IS_WIN ? (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';') : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const p = path.join(dir, 'dsh' + ext.toLowerCase());
      try {
        fs.accessSync(p, fs.constants.X_OK);
        if (fs.statSync(p).isFile()) return p;
      } catch {
        /* 继续找下一个 */
      }
    }
  }
  return null;
}

/** 启动 DSH Web：优先 PATH 中的 dsh，回退 npx */
function startDshWeb() {
  const dshPath = findDshOnPath();
  const args = ['web', '--no-open', '--port', String(PORT)];
  if (dshPath) {
    via = `${dshPath} ${args.join(' ')}`;
    spawnChild(dshPath, args, IS_WIN);
  } else {
    via = `npx @deepseek-ai/dsh ${args.join(' ')}`;
    spawnChild('npx', ['@deepseek-ai/dsh', ...args], IS_WIN);
  }
  log('启动 DSH Web ->', via, `(pid=${dsh.pid})`);
}

function spawnChild(cmd, args, useShell) {
  dsh = spawn(cmd, args, {
    stdio: ['ignore', 'ignore', 'pipe'],
    detached: !IS_WIN, // unix: 独立进程组，便于整组终止
    shell: useShell, // windows: npx/dsh 可能是 .cmd
    windowsHide: true,
  });

  dsh.stderr.on('data', (d) => {
    stderrTail = (stderrTail + d.toString()).slice(-4000);
  });
  dsh.on('error', (err) => {
    childError = err;
    log('dsh 子进程错误:', err.message);
  });
  dsh.on('exit', (code, signal) => {
    childExit = { code, signal };
    if (quitting || dshStoppedByUs) return;
    log('dsh 进程意外退出 code=', code, 'signal=', signal);
    dialog.showErrorBox(
      'dsh-desktop',
      `DSH Web 进程已意外退出 (code=${code ?? '-'} signal=${signal ?? '-'})。\n\n` +
        (stderrTail ? `输出尾部:\n${stderrTail}\n\n` : '') +
        `本程序即将关闭。`
    );
    quitting = true;
    app.quit();
  });
}

/** 终止 dsh 进程树（unix 按进程组，windows 用 taskkill /T） */
function signalTree(sig) {
  const child = dsh;
  if (!child || child.pid == null || dshStoppedByUs) return;
  dshStoppedByUs = true;
  try {
    if (IS_WIN) {
      if (sig === 'SIGKILL' || sig === 'TASKKILL') {
        spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      }
    } else {
      try {
        process.kill(-child.pid, sig); // 负 pid = 杀整个进程组
      } catch {
        /* 进程可能已自行退出 */
      }
    }
  } catch {
    /* 忽略终止时的竞态错误 */
  }
  log('已向 DSH 进程组发送', sig);
}

function describeChildFailure() {
  const parts = [`启动命令: ${via || '-'}`];
  if (childError) parts.push(`启动错误: ${childError.message}`);
  if (childExit) parts.push(`进程退出: code=${childExit.code ?? '-'} signal=${childExit.signal ?? '-'}`);
  if (stderrTail) parts.push(`输出尾部:\n${stderrTail}`);
  return parts.join('\n');
}

function fatal(message) {
  log('致命错误:', message);
  dialog.showErrorBox('dsh-desktop', message);
  app.exit(1);
}

// ---------------- 窗口 ----------------

function loadingHtml() {
  return `<!doctype html><html><head><meta charset="utf-8"><title>dsh-desktop</title>
<style>
  html,body{height:100%;margin:0;background:#14141f;color:#cfd3e6;font-family:system-ui,-apple-system,"Segoe UI",sans-serif}
  body{display:flex;align-items:center;justify-content:center}
  .box{text-align:center}
  .dot{width:10px;height:10px;margin:0 auto 18px;border-radius:50%;background:#7c8cff;animation:p 1s ease-in-out infinite}
  @keyframes p{0%,100%{opacity:.25;transform:scale(.8)}50%{opacity:1;transform:scale(1.15)}}
  code{color:#7c8cff}
  .sub{margin-top:8px;opacity:.6;font-size:13px}
</style></head><body><div class="box">
<div class="dot"></div>
<div>正在启动 DSH Web…</div>
<div class="sub">目标地址 <code>${BASE_URL}</code></div>
</div></body></html>`;
}

function createWindow(loadNow) {
  win = new BrowserWindow({
    width: 1280,
    height: 830,
    minWidth: 720,
    minHeight: 480,
    title: 'dsh-desktop',
    backgroundColor: '#14141f',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  Menu.setApplicationMenu(null);
  win.once('ready-to-show', () => win.show());

  // 关闭行为：外部服务 -> 弹窗提示不会关闭它；本程序启动的服务 -> 直接退出并终止 dsh
  win.on('close', (e) => {
    if (quitting || !win) return;
    if (dsh) return; // 生命周期一致：随窗口关闭终止 dsh，无需确认
    e.preventDefault();
    const choice = dialog.showMessageBoxSync(win, {
      type: 'info',
      title: 'dsh-desktop',
      message: `检测到 ${BASE_URL} 上的 DSH 服务并非由本程序启动。`,
      detail: '关闭窗口后，该 DSH 服务将继续在后台运行，不会被关闭。',
      buttons: ['关闭窗口', '取消'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    });
    if (choice === 0) {
      quitting = true;
      win.destroy();
      app.quit();
    }
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(BASE_URL)) return { action: 'allow' };
    // 外部链接交给系统浏览器
    require('electron').shell.openExternal(url);
    return { action: 'deny' };
  });

  // 保留基础快捷键：F5 / Ctrl+R 刷新，Ctrl+Shift+I 开发者工具
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return;
    const ctrl = input.control || input.meta;
    const key = (input.key || '').toLowerCase();
    if (input.key === 'F5' || (ctrl && !input.shift && key === 'r')) {
      win.webContents.reload();
      e.preventDefault();
    } else if (ctrl && input.shift && key === 'i') {
      win.webContents.toggleDevTools();
      e.preventDefault();
    }
  });

  win.on('closed', () => {
    win = null;
  });

  if (loadNow) {
    win.loadURL(BASE_URL);
  } else {
    win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(loadingHtml()));
  }
}

// ---------------- 启动流程 ----------------

async function bootstrap() {
  log(`目标服务: ${BASE_URL}`);

  let ready = await pingPort();
  if (ready) {
    log('检测到 3080 端口已有 DSH Web 服务，直接打开窗口（关闭时不会停止该服务）');
  } else {
    log('端口未就绪，启动 DSH Web…');
    startDshWeb();
    ready = await waitReady(READY_TIMEOUT_MS);
    if (!ready) {
      signalTree(IS_WIN ? 'TASKKILL' : 'SIGTERM');
      fatal(
        `无法启动 DSH Web 服务（${Math.round(READY_TIMEOUT_MS / 1000)} 秒内 ${BASE_URL} 未就绪）。\n\n` +
          `已尝试:\n` +
          `  1. PATH 中的 dsh -> ${findDshOnPath() ? '已找到但未在端口就绪' : '未找到'}\n` +
          `  2. npx @deepseek-ai/dsh -> 已尝试\n\n` +
          describeChildFailure() +
          `\n\n请确认已安装 Node.js 与 @deepseek-ai/dsh 后重试。`
      );
      return;
    }
    log('DSH Web 已就绪');
  }

  createWindow(ready);
  log('窗口已打开');
}

// ---------------- 应用生命周期 ----------------

if (!app.requestSingleInstanceLock()) {
  // 已有实例在运行，直接退出
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
  });

  app.whenReady().then(bootstrap);

  // 任何退出流程（app.quit / 信号触发的优雅退出）的必经事件：
  // 在这里置位 quitting，确保关闭确认弹窗只对「用户点 X」生效
  app.on('before-quit', () => {
    quitting = true;
  });

  app.on('window-all-closed', () => {
    app.quit();
  });

  app.on('will-quit', () => {
    quitting = true;
    // 生命周期一致：随程序退出终止本程序启动的 dsh（外部服务场景 dsh 为 null，不会误杀）
    signalTree(IS_WIN ? 'TASKKILL' : 'SIGTERM');
  });

  // 兜底：无论以何种方式退出，都确保 dsh 被终止
  process.on('exit', () => {
    if (dsh && !dshStoppedByUs) signalTree('SIGKILL');
  });

  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      // before-quit 监听器会置 quitting，窗口关闭时不会再弹确认框
      app.quit();
    });
  }
}
