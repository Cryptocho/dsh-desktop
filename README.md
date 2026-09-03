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

## 可选环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `DSH_DESKTOP_PORT` | `3080` | 目标端口 |
| `DSH_DESKTOP_READY_TIMEOUT_MS` | `120000` | 等待服务就绪的超时（毫秒） |

## 其他行为

- 单实例锁：重复启动会唤起已有窗口。
- 外部链接（非本站）交给系统浏览器打开。
- 保留快捷键：`F5` / `Ctrl+R` 刷新，`Ctrl+Shift+I` 开发者工具。
