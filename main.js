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
 *   4. 常驻系统托盘：点 X 仅隐藏到托盘，托盘右键菜单「显示主窗口 / 退出」
 *
 * 环境变量（均可选）:
 *   DSH_DESKTOP_PORT               目标端口，默认 3080
 *   DSH_DESKTOP_READY_TIMEOUT_MS   等待服务就绪的超时，默认 120000
 *   DSH_DESKTOP_TRAY               置 0/false/off 禁用托盘，点 X 恢复旧关闭行为
 */

const { app, BrowserWindow, Menu, dialog, shell, Tray, Notification } = require('electron');
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
const IS_LINUX = process.platform === 'linux';
// DSH_DESKTOP_TRAY=0/false/off 时禁用托盘；点 X 恢复「外部服务弹窗确认 / 自启服务直接退出」旧行为
const TRAY_ENABLED = !/^(0|false|off|no)$/i.test(process.env.DSH_DESKTOP_TRAY || '');

// ---------------- 运行状态 ----------------

let win = null;
let tray = null; // 系统托盘实例；null 表示未启用（被禁用、缺图标或创建失败）
let dsh = null; // 本程序启动的 dsh 子进程；null 表示使用外部已就绪的服务
let via = null; // 实际使用的启动方式描述
let quitting = false;
let hideNotified = false; // 「已最小化到托盘」是否提示过（仅首次提示）
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

// ---------------- 托盘 ----------------

/** 显示并聚焦主窗口（托盘点击 / 二次启动唤起共用） */
function showWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

/** 真正退出：置位 quitting 后走 app.quit()，will-quit 会终止 dsh 进程树 */
function quitApp() {
  quitting = true;
  app.quit();
}

/** 首次隐藏到托盘时发系统通知，避免用户误以为程序已退出 */
function notifyHiddenToTray() {
  if (hideNotified) return;
  hideNotified = true;
  try {
    if (!Notification.isSupported()) return;
    const n = new Notification({
      title: 'dsh-desktop 已最小化到托盘',
      body: '程序仍在后台运行，点击托盘图标可重新打开窗口。',
      silent: true,
    });
    n.on('click', showWindow);
    n.show();
  } catch (err) {
    log('托盘通知失败(忽略):', err.message);
  }
}

function createTray() {
  if (!TRAY_ENABLED || tray) return;
  let iconPath = path.join(__dirname, 'assets', 'tray.png');
  try {
    fs.accessSync(iconPath);
  } catch {
    log('未找到托盘图标，跳过托盘:', iconPath);
    return;
  }
  // Linux appindicator 要求图标文件在托盘生命周期内保持在磁盘上：
  // 打包后图标位于 asar 内，先复制到 userData 再交给 Tray 最稳妥
  if (IS_LINUX && iconPath.includes('app.asar')) {
    try {
      const dest = path.join(app.getPath('userData'), 'tray.png');
      fs.copyFileSync(iconPath, dest);
      iconPath = dest;
    } catch {
      /* 复制失败则直接用 asar 内路径 */
    }
  }
  tray = new Tray(iconPath);
  tray.setToolTip('dsh-desktop');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '显示主窗口', click: showWindow },
      { type: 'separator' },
      { label: '退出', click: quitApp },
    ])
  );
  // Windows/macOS 左键单击唤起窗口；部分 Linux 桌面（appindicator）不支持 click 事件，
  // 那种环境通过右键菜单操作
  tray.on('click', showWindow);
  log('托盘已创建:', iconPath);
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
    icon: path.join(__dirname, 'assets', 'icon.png'), // Linux/Windows 窗口图标
    backgroundColor: '#14141f',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false, // 禁用拼写检查
    },
  });

  Menu.setApplicationMenu(null);
  win.once('ready-to-show', () => win.show());

  // 关闭行为：启用托盘 -> 点 X 仅隐藏到托盘（首次有通知）；
  // 未启用托盘 -> 外部服务弹窗确认 / 本程序启动的服务直接退出并终止 dsh
  win.on('close', (e) => {
    if (quitting || !win) return;
    if (tray) {
      e.preventDefault();
      win.hide();
      notifyHiddenToTray();
      return;
    }
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
  createTray();
  log('窗口已打开');
}

// ---------------- 应用生命周期 ----------------

if (!app.requestSingleInstanceLock()) {
  // 已有实例在运行（它将收到 second-instance 事件并唤起窗口），本实例直接退出
  log('检测到已有 dsh-desktop 实例在运行，本实例退出');
  app.quit();
} else {
  app.on('second-instance', () => {
    showWindow(); // 唤起已有实例的主窗口（可能正隐藏在托盘）
  });

  if (IS_WIN) app.setAppUserModelId('com.cryptocho.dsh-desktop'); // Windows 通知需要
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
