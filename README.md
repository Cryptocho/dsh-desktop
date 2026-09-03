# dsh-desktop

极简 Electron 壳程序：在桌面窗口中承载 [DeepSeek Harness](https://www.electronjs.org) Web UI（`http://localhost:3080`）。

## 启动逻辑

1. 先探测 `http://localhost:3080` 是否已有服务在运行：
   - **已就绪** → 直接打开窗口；关闭窗口时会弹窗提示「该 DSH 服务将继续在后台运行，不会被关闭」。
   - **未就绪** → 依次尝试启动 DSH Web（均带 `--no-open`，避免弹出系统浏览器）：
     1. PATH 中的 `dsh web --no-open`
     2. 回退：`npx @deepseek-ai/dsh web --no-open`
     3. 仍失败 → 弹错误对话框并退出。
2. 服务就绪后在窗口中加载页面。
3. 由本程序启动的 dsh 与本程序**生命周期一致**：程序退出时终止整个 dsh 进程树（Unix 按进程组 `SIGTERM`→兜底 `SIGKILL`；Windows 用 `taskkill /T /F`）。

## 使用

```bash
npm install   # 首次
npm start
```

## 托盘与关闭行为

- 默认启用系统托盘：点击窗口 **X** 只是**隐藏到托盘**，程序与 DSH 服务继续在后台运行；首次隐藏会弹一条系统通知。
- 托盘交互：左键单击唤起主窗口（Windows/macOS；部分 Linux 桌面如 GNOME appindicator 仅支持右键菜单）；右键菜单：**显示主窗口 / 退出**。
- 只有托盘菜单的「**退出**」（或对进程发 `SIGINT`/`SIGTERM`）才会真正退出，并终止本程序启动的 dsh 进程树；隐藏在托盘期间服务不受影响。
- 设 `DSH_DESKTOP_TRAY=0`（或 `false`/`off`）禁用托盘：点 X 恢复旧的关闭行为（外部服务弹窗确认 / 自启服务直接退出）。
- 图标：`assets/tray.png`（64×64，托盘）与 `assets/icon.png`（256×256，窗口图标），由根目录 `icon.jpg` 经 ImageMagick 转换而来；换图标时替换 `icon.jpg` 后重新执行同样的转换即可。

## 打包（Electron Forge）

```bash
npm run package   # 仅打包，产物在 out/dsh-desktop-linux-x64/
npm run make      # 打包 + 产出 zip，产物在 out/make/zip/linux/x64/
```

- 配置见 `forge.config.js`（asar 开启，当前目标：linux x64 + maker-zip）。
- **Node v26.3.0 已知坑**：`extract-zip`/`yauzl` 解压大 zip 时会中途静默退出（forge 卡在
  "Finalizing package" 无产物）。已用 `scripts/patch-extract-zip.js` 改写为系统 `unzip`
  实现，`npm install` 时由 postinstall 自动重放，无需手动干预。
- deb 目标未配置（需要系统 `dpkg-deb`/`fakeroot`）；如需其他平台目标，在
  `forge.config.js` 的 `makers` 中追加并安装对应 maker 包。

## 可选环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `DSH_DESKTOP_PORT` | `3080` | 目标端口 |
| `DSH_DESKTOP_READY_TIMEOUT_MS` | `120000` | 等待服务就绪的超时（毫秒） |
| `DSH_DESKTOP_TRAY` | 开启 | 置 `0`/`false`/`off` 禁用托盘，点 X 恢复旧关闭行为 |

## 其他行为

- 单实例锁：重复启动会唤起已有窗口（包括正隐藏在托盘的情况）。
- 外部链接（非本站）交给系统浏览器打开。
- 保留快捷键：`F5` / `Ctrl+R` 刷新，`Ctrl+Shift+I` 开发者工具。
