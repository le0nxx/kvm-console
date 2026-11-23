# iDRAC9 Web KVM 逆向记录（分支 dell-web-kvm）

## 入口
- 虚拟控制台设置页：`https://<idrac>/restgui/index.html?<token>&vconsole`
- 启动按钮：`#iDRAC.VirtualConsole.link`（文本 "Start the Virtual Console"）
- 启动后弹窗：`https://<idrac>/restgui/vconsole/index.html`

## Viewer 连接
- WebSocket：`wss://<idrac>/vnc/vconsole?vck=<数字token>`
- Cookie：`-http-session-<随机后缀>=<hex>`
- 子协议：`binary`
- 帧格式：自定义封装（控制帧 + RFB），不是裸 RFB；只有部分帧内出现 `RFB 003.008`
- 启动弹窗建立 viewer 会话；直接在新视图加载 viewer URL 会一直停在 `Connecting Viewer...`
- 关闭弹窗后，用捕获的 Cookie 直接连 WS 仍可建立连接（Node ws 验证通过），说明会话在服务端仍有效

## 反向代理原型
- 本地 HTTP 代理转发 viewer 静态资源，WS `noServer` 升级转发到 wss，注入 Cookie，可加载 viewer 页面
- 但 viewer 仍在 `Connecting Viewer...`：
  - 需要确认 vck 是否由服务端 bootstrap 下发、是否与 Cookie 绑定
  - 需要把 viewer 内绝对 `wss://` 改写到本地代理
  - 需要处理 viewer 的 `RFB`/自定义帧转发（纯字节转发即可，但不能改包）

## 下一步
1. 抓取 viewer 首次 HTTP 响应中的 bootstrap（vck / 配置）
2. 在代理层重写 bootstrap 与 WebSocket 地址到本地
3. 内嵌代理页面到 WebContentsView，验证 canvas 出现且键鼠可用

## 2026-11-20 继续逆向

- Viewer 不读 URL 里的 vck；父页面通过 `postMessage({type:'VC_SESSION_DATA', VCSID, VCSID2, ip, kvmport})` 把会话交给 viewer。
- 通过包装 `window.open` 返回的窗口对象的 `postMessage`，可以截获该数据，例如：
  `{"type":"VC_SESSION_DATA","VCSID":"253174073174209100053219","VCSID2":"054056206141039074057193","ip":"192.168.8.251","kvmport":"443"}`
- 在独立 viewer 窗口里 `window.postMessage(sessionData, origin)` 后，viewer 会创建 canvas 并尝试连接，但服务端返回 `Alert: Login denied`。
- 工作正常的 popup viewer 的 WS：`wss://<ip>/vnc/vconsole?vck=<VCSID>`，首帧是自定义帧（`0xF7...`）再进入 `RFB 003.008`。
- 结论：VCSID 很可能与打开 viewer 的 popup/opener 绑定，或是一次性会话；需要继续比对 RFB 认证帧或让 postMessage 来自 opener。
