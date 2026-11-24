/**
 * Bilingual catalog and DOM translator.
 *
 * The markup and the main process keep canonical Chinese strings; this module
 * renders them in English when the UI language is English. Two layers:
 *
 *   MESSAGES  exact phrase -> English (labels, buttons, full sentences)
 *   PATTERNS  composed message -> English (messages carrying numbers or names)
 *
 * A text node that matches neither is left as-is and recorded in `misses`, so a
 * smoke run can prove no Chinese leaks into the English UI. There is no fuzzy
 * substring rewriting: a translation either matches a whole message or it does
 * not appear.
 */
/* global module */
(function () {
  const MESSAGES = {
    "多路控制台 · beta": "Multi-console · beta",
    "多路控制台": "Multi-console",
    "戴尔选 VNC 会占用虚拟控制台，Web KVM 将不可用。": "Dell VNC occupies the virtual console; Web KVM will be blocked.",
    "凭据：不可用": "Credentials: Unavailable",
    "凭据：未知": "Credentials: Unknown",
    "凭据：默认": "Credentials: Default",
    "凭据：已保存": "Credentials: Saved",
    "默认凭据可用": "Default credentials",
    "已保存凭据": "Saved credentials",
    "已保存": "Saved",
    "默认凭据": "Default",
    "Redfish 可用 / 凭据未知": "Redfish reachable / credentials unknown",
    "HTTP 可达": "HTTP reachable",
    "未知设备": "Unknown device",
    "文本预设（点击直接发送，可增删）": "Text presets (click to send, add or remove)",
    "新增预设，例如 Admin@9000": "New preset, e.g. Admin@9000",
    "添加": "Add",
    "删除": "Delete",
    "还没有预设": "No presets yet",
    "点击填入": "Click to fill",
    "广播": "Broadcast",
    "启用广播": "Start broadcast",
    "停止广播": "Stop broadcast",
    "未启用": "Off",
    "先勾选至少一个目标": "Select at least one target",
    "连接": "Connect",
    "扫描网段": "Scan subnet",
    "历史": "History",
    "虚拟镜像": "Virtual media",
    "虚拟媒体": "Virtual media",
    "终端": "Terminal",
    "执行": "Run",
    "清屏": "Clear",
    "输入命令，例如 getsysinfo / mc info": "Enter a command, e.g. getsysinfo / mc info",
    "下载": "Downloads",
    "打开目录": "Open folder",
    "清空": "Clear",
    "还没有下载": "No downloads yet",
    "文本/快捷键": "Text / Keys",
    "电源": "Power",
    "全部重连": "Reconnect all",
    "快速切换": "Quick Connect",
    "快速连接": "Quick Connect",
    "快捷键": "Shortcuts",
    "设置": "Settings",
    "自动": "Auto",
    "日间": "Light",
    "夜间": "Dark",
    "跟随系统": "System",
    "连接一台 BMC": "Connect a BMC",
    "连接 BMC": "Connect BMC",
    "填地址和密码直接连；不想要记录就点「仅连接」，关掉标签即消失。": "Enter the address and password to connect. Use \"Connect only\" to skip history; closing the tab removes it.",
    "连接一台 BMC，或者扫描同网段自动发现。": "Connect a BMC, or scan the local subnet to discover one.",
    "最近连接": "Recent",
    "还没有历史连接": "No history yet",
    "地址": "Address",
    "地址（可选）": "Address (optional)",
    "端口": "Port",
    "协议": "Scheme",
    "厂商": "Vendor",
    "连接方式": "Mode",
    "用户名": "Username",
    "密码": "Password",
    "备注名（可选）": "Name (optional)",
    "不填就用 IP 显示": "Defaults to the IP address",
    "KVM 地址（可选）": "KVM URL (optional)",
    "自动识别失败时手填": "Fill in if auto-detect fails",
    "留空则沿用历史密码": "Leave blank to reuse the saved password",
    "自动（推荐）": "Auto (recommended)",
    "仅连接（不记历史）": "Connect only (no history)",
    "仅连接": "Connect only",
    "重置输入": "Reset form",
    "存为预设": "Save preset",
    "恢复默认": "Reset defaults",
    "取消": "Cancel",
    "关闭": "Close",
    "目标（可多选）": "Targets (multi-select)",
    "全选": "All",
    "清除": "Clear",
    "重置": "Reset",
    "勾选要接收键盘广播的目标，然后启用。广播只转发普通按键和 Shift 组合。": "Select the targets that should receive keyboard broadcasts, then start. Only normal keys and Shift combos are forwarded.",
    "通过 Redfish 发送；强制关机会立即断电。": "Sent via Redfish; forced power off cuts power immediately.",
    "输入主机名 / IP / 厂商，回车直达…": "Type hostname / IP / vendor, press Enter to connect...",
    "功能": "Functions",
    "切换聚焦/窗格": "Toggle focus / grid",
    "删除连接": "Delete connection",
    "已删除连接": "Connection deleted",
    "聚焦": "Focus",
    "重连": "Reconnect",
    "重连选中": "Reconnect selected",
    "重置连接": "Reset connection",
    "确认电源操作": "Confirm power action",
    "确认发送": "Send",
    "勾选要重连的服务器；重置会清除本机保存的凭据、Cookie 和连接缓存。": "Select servers to reconnect. Reset clears locally saved credentials, cookies and connection cache.",
    "Redfish 可用": "Redfish reachable",
    "开机": "Power on",
    "软关机": "Soft shutdown",
    "强制关机": "Force off",
    "软重启": "Soft restart",
    "强制重启": "Force restart",
    "无凭据": "No credentials",
    "连接选中": "Connect selected",
    "没有已挂载的镜像": "No mounted image",
    "设置下次从光驱启动": "Boot from CD/DVD next time",
    "命令会在勾选的目标上逐台执行；凭据由本机连接记录提供。": "Runs on each selected target; credentials come from local connection records.",
    "未选择文件": "No file selected",
    "选择镜像": "Select image",
    "挂载选中": "Mount selected",
    "卸载选中": "Unmount selected",
    "常用快捷键（发送到选中）": "Common keys (to selected)",
    "发送到选中": "Send to selected",
    "粘贴要输入到 KVM 的文本（换行=Enter）": "Text to send to the KVM (newline = Enter)",
    "点击右侧按键框后按下组合键；Esc 取消，退格清除": "Click a key box, then press a shortcut. Esc cancels, Backspace clears.",
    "未绑定": "Unbound",
    "Web 控制台": "Web console",
    "VNC 控制台": "VNC console",
    "正在打开管理页面": "Opening the management page",
    "正在自动登录": "Signing in automatically",
    "正在进入 KVM": "Entering the KVM",
    "正在连接 iDRAC 控制台…": "Connecting to the iDRAC console...",
    "连接 iDRAC 控制台超时": "Timed out connecting to the iDRAC console",
    "正在重连全部标签…": "Reconnecting all tabs...",
    "标签顺序已保存": "Tab order saved",
    "正在扫描…": "Scanning...",
    "系统钥匙串不可用，凭据将以 base64 明文保存在本机": "System keychain unavailable; credentials will be stored locally in base64.",
    "该设备默认凭据不可用，请补充用户名/密码": "Default credentials failed; enter a username/password.",
    "先勾选至少一台服务器": "Select at least one server.",
    "先输入或粘贴要发送的文本": "Enter or paste text to send.",
    "地址不能为空": "Address is required.",
    "请输入 BMC 地址": "Enter a BMC address.",
    "请先填写密码，再上传许可": "Enter the password before uploading a license.",
    "先在表单里填好 BMC 地址和用户名，再上传许可": "Fill in the BMC address and username before uploading a license.",
    "会立即生效，确定发送到": "This takes effect immediately. Send to",
    "开始扫描": "Start scan",
    "取消扫描": "Cancel scan",
    "扫描本网段": "Scan local subnet",
    "网段": "Subnet",
    "还没有结果，输入网段后点“开始扫描”": "No results yet. Enter a subnet and start scanning.",
    "完成，发现": "Done, found",
    "台": "hosts",
    "个标签": "tabs",
    "就绪": "ready",
    "没有打开的会话": "No open sessions",
    "正在打开": "Opening",
    "正在登录": "Signing in",
    "正在连接…": "Connecting...",
    "在线": "Online",
    "离线": "Offline",
    "已完成": "Done",
    "正在扫描": "Scanning",
    "已连接": "Connected",
    "已断开": "Disconnected",
    "错误": "Error",
    "手动": "Manual",
    "未知": "Unknown",
    "打开": "Open",
    "导入许可": "Import license",
    "显示控制台": "Show console",
    "关闭标签": "Close tab",
    "已打开": "Open",
    "手动上传许可": "Upload license manually",
    "虚拟控制台/虚拟介质需要 Enterprise 许可证": "Virtual console and virtual media require an Enterprise license",
    "华为 iBMC 与超聚变 iBMC 同源，KVM 入口通常在“远程控制”下": "Huawei iBMC and xFusion iBMC share the same codebase; the KVM entry is usually under Remote Control.",
    "型号与固件差异较大，必要时在设备里手填 KVM 地址": "Models and firmware vary widely; fill in the KVM URL manually if auto-detect fails.",
    "使用通用登录与入口识别，失败时可手动操作或填 KVM 地址": "Uses generic login and console detection; if it fails, operate manually or set the KVM URL.",
    "iDRAC 许可文件": "iDRAC license file",
    "拖拽 .xml 许可到这里，或点击选择": "Drop the .xml license here, or click to choose",
    "主题：跟随系统（点击切换日间）": "Theme: System (click for light)",
    "主题：日间（点击切换夜间）": "Theme: Light (click for dark)",
    "主题：夜间（点击恢复跟随系统）": "Theme: Dark (click for system)",
    "已挂载": "Mounted",
    "未挂载": "Not mounted",
    "已卸载": "Unmounted",
    "可用 / 凭据未知": "Reachable / credentials unknown",
    "可达": "Reachable",
    "不可达": "Unreachable",
    "失败": "Failed",
    "完成": "Done",
    "正在导入许可…": "Importing license...",
    "许可已导入": "License imported",
    "许可导入失败": "License import failed",
    "华为 / 超聚变": "Huawei / xFusion",
    "戴尔 iDRAC": "Dell iDRAC",
    "浪潮 ISBMC": "Inspur ISBMC",
    "通用 / 其他": "Generic / Other",
    "搜索": "Search",
    "设置语言": "Language",
    "主题": "Theme",
    "语言": "Language",
    "自动（跟随系统）": "Auto (system)",
    "标签": "Tabs",
    "应用": "Application",
    "视图": "View",
    "面板": "Panels",
    "操作": "Actions",
    "上一个标签": "Previous tab",
    "下一个标签": "Next tab",
    "关闭当前标签": "Close current tab",
    "新建连接": "New connection",
    "退出应用": "Quit application",
    "切换到网格": "Switch to grid",
    "聚焦当前标签": "Focus current tab",
    "历史记录": "History",
    "文本 / 快捷键": "Text / Keys",
    "电源控制": "Power control",
    "切换主题": "Toggle theme",
    "English": "English",
    "跟随系统语言": "System language",
    "网格布局": "Grid layouts",
    "华为（新固件）": "Huawei (new firmware)",
    "浪潮（旧）": "Inspur (legacy)",
    "华为/超聚变": "Huawei/xFusion",
    "浪潮": "Inspur",
    "通用": "Generic",
    "不可用": "Unavailable",
    "默认": "Default",
    "临时": "ephemeral",
    "未知错误": "Unknown error",
    "未知动作": "Unknown action",
    "未知电源操作": "Unknown power action",
    "该组合已在预设里": "That combination is already a preset",
    "按下组合键…": "Press a key combination...",
    "请输入命令": "Enter a command first",
    "(无输出)": "(no output)",
    "等待命令": "Waiting for a command",
    "重试上传": "Retry upload",
    "删除这个预设": "Delete this preset",
    "带外 Web（免密打开）": "Out-of-band web console (opens without a password)",
    "扫描会尝试常见默认凭据（每台最多 2 次，避免锁号）": "Scanning tries common default credentials (up to 2 per host to avoid lockouts).",
    "需要手动处理": "needs manual attention",
    "连接失败": "Connection failed",
    "未配置": "not configured",
    "该 iBMC 只提供 Java KVM（kvm.jnlp），已阻止下载；请使用 HTML5 控制台或连接页的 VNC": "This iBMC only offers Java KVM (kvm.jnlp), which was blocked. Use the HTML5 console, or enable VNC on the connect page.",
    "正在打开 iDRAC 控制台": "Opening the iDRAC console",
    "正在接管厂商控制台窗口": "Taking over the vendor console window",
    "渲染进程反复退出，已停止自动重启；下次启动会自动改用软件渲染": "The renderer kept exiting, so automatic restarts stopped. The next launch uses software rendering.",
    "页面无响应": "Page is not responding",
    "请手动登录": "Please sign in manually",
    "iDRAC 内嵌控制台不可用": "The embedded iDRAC console is unavailable",
    "VNC 已开启，但控制台连接失败（密码可能被改过或会话已满）": "VNC is enabled but the console connection failed (the password may have changed, or the session is full)",
    "无法读取登录页": "Could not read the sign-in page",
    "iDRAC 会话数已满：请用 racadm closessn -a 或浏览器登出后重试": "All iDRAC sessions are in use. Run racadm closessn -a or sign out in a browser, then retry.",
    "缺少用户名或密码，请手动填写后登录": "Missing username or password; fill them in and sign in manually.",
    "账号可能已被锁定，请手动处理": "The account may be locked; please handle it manually.",
    "该设备要求首次登录修改密码，请手动完成": "This device requires a password change on first sign-in; please complete it manually.",
    "未找到登录表单，请手动登录": "No sign-in form found; please sign in manually.",
    "自动填充未生效（页面可能禁止脚本输入），请手动登录": "Auto-fill did not take effect (the page may block scripted input); please sign in manually.",
    "该设备要求修改默认密码，请手动完成": "This device requires changing the default password; please complete it manually.",
    "自动登录未成功（凭据错误或需要验证码），请手动登录": "Automatic sign-in failed (wrong credentials or a captcha is required); please sign in manually.",
    "已启用 VNC": "VNC enabled",
    "KVM 会话数已满，正在清理旧会话…": "KVM sessions are full; clearing old sessions...",
    "已清理旧会话，正在重新登录…": "Cleared old sessions; signing in again...",
    "KVM 会话数已满，自动清理失败：请在 iBMC「用户与安全 → 在线用户」注销旧会话后重连": "KVM sessions are full and automatic cleanup failed. Sign out old sessions under iBMC \"Users & Security → Online Users\", then reconnect.",
    "未找到 KVM 入口，请手动点击，或在连接里填写 KVM 地址": "KVM entry not found. Click it manually, or set the KVM URL when connecting.",
    "检测到登录成功，正在打开控制台": "Signed in; opening the console",
    "未检测到画面信号，但页面已打开，可直接操作": "No video signal detected, but the page is open and usable",
    "登录": "Sign in",
    "检测到已登录，正在进入 KVM": "Already signed in; entering the KVM",
    "会话超时，正在重新连接": "Session timed out; reconnecting",
    "登录态丢失，正在重新登录": "Sign-in state lost; signing in again",
    "许可已就绪，正在重新进入 KVM": "License ready; re-entering the KVM",
    "当前页面没有 CD/DVD 菜单": "This page has no CD/DVD menu",
    "没有找到镜像文件选择框": "No image file picker found",
    "已选择镜像，但 BMC 没有启用连接按钮": "The image was selected, but the BMC did not enable its connect button",
    "本地上传已开始，但 BMC 没有在 20 秒内确认连接": "The local upload started, but the BMC did not confirm the connection within 20 seconds",
    "媒体令牌不存在": "Media token not found",
    "命令引号未闭合": "Unclosed quote in the command",
    "命令为空": "Command is empty",
    "命令超时（60 秒）": "Command timed out (60 s)",
    "记录不存在": "Record not found",
    "会话不存在": "Session not found",
    "没有保存的密码": "No saved password",
    "扫描已在进行": "A scan is already running",
    "网段格式应为 192.168.10.0/24": "Subnet must look like 192.168.10.0/24",
    "选择要挂载的镜像": "Select an image to mount",
    "镜像文件": "Disk images",
    "所有文件": "All files",
    "设备不存在": "Device not found",
    "未找到系统资源": "System resource not found",
    "无法通过网页卸载，请在 KVM 工具栏中弹出光盘": "Cannot eject from the web UI; use the eject option in the KVM toolbar.",
    "会话未就绪": "Session is not ready",
    "未找到虚拟介质入口，请在控制台里手动打开": "Virtual media entry not found; open it manually in the console.",
    "选择 iDRAC 许可文件": "Select an iDRAC license file",
    "许可文件": "License files",
    "该设备没有可用的虚拟光驱（可能缺少许可证或固件不支持 Redfish 虚拟介质）": "No virtual optical drive available (license missing, or the firmware lacks Redfish virtual media)",
    "未找到虚拟光驱": "No virtual optical drive found",
    "Redfish 认证失败（用户名或密码错误）": "Redfish authentication failed (wrong username or password)",
    "该设备未提供标准 Redfish 服务": "This device does not expose a standard Redfish service",
    "BMC 未接受虚拟介质连接": "The BMC did not accept the virtual media connection",
    "Redfish 不可用，跳过许可检查": "Redfish unavailable; skipping the license check",
    "该设备没有 Redfish 许可服务": "This device has no Redfish license service",
    "已安装有效许可": "Valid license installed",
    "（该机器可能已经用过试用许可，需换正式许可）": " (this machine may have used its trial license; a full license is required)",
    "许可导入失败：无法解析该 XML 文件": "License import failed: cannot parse this XML file",
    "许可导入失败：该设备没有 Redfish 许可服务": "License import failed: this device has no Redfish license service",
    "没有可清理的 iDRAC 会话": "No iDRAC sessions to clear",
    "VNC 服务未开放端口（当前 iBMC 固件可能不支持 VNC）": "The VNC service opened no port (this iBMC firmware may not support VNC)",
    "VNC 已就绪": "VNC ready",
    "{n} 个标签 · {ready} 就绪": "{n} tabs · {ready} ready",  "{n} 失败": "{n} failed",
    "{n} 分钟前": "{n} min ago",
    "{n} 小时前": "{n} h ago",
    "{n} 天前": "{n} d ago",
    "{host}：{note}": "{host}: {note}",
    "{name}：{detail}": "{name}: {detail}",
    "失败：{error}": "Failed: {error}",
"需手动处理": "Needs attention",
    "下载管理": "Download manager",
    "打开 racadm / ipmitool 终端": "Open the racadm / ipmitool terminal",
    "待连接": "Not connected",
    "BMC 地址": "BMC address",
    "＋ 存为预设": "+ Save preset",
    "键盘广播": "Keyboard broadcast",
    "重连 / 重置": "Reconnect / Reset",
    "BMC 端口": "BMC port",
    "Web/Redfish 端口，通常 443；VNC 端口自动探测": "Web/Redfish port, usually 443; the VNC port is auto-detected",
    "VNC（自动开启）": "VNC (turned on automatically)",
    "确认操作": "Confirm action",
    "键盘广播到所有窗格": "Broadcast the keyboard to every pane",
    "BMC 地址不能为空": "The BMC address is required",
    "先填好用户名和密码，再存为预设": "Fill in the username and password before saving a preset",
    "从历史中删除这条记录？（不影响 BMC 本身）": "Delete this entry from history? (The BMC itself is unaffected.)",
    "将清除 {n} 台服务器在本机保存的凭据、Cookie 和连接缓存，确定继续？":
      "This clears saved credentials, cookies and connection cache for {n} servers. Continue?"
};

  // Ideographs plus CJK punctuation (：（）「」…), so keys like "SN：" match too.
  const CJK = /[\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/;
  const hasCjk = (text) => CJK.test(text);

  const fill = (text, params) =>
    params
      ? text.replace(/\{(\w+)\}/g, (m, key) =>
          Object.prototype.hasOwnProperty.call(params, key) ? String(params[key]) : m,
        )
      : text;

  /** Patterns receiving (match, word) where word() translates a label exactly. */
  function makePatterns(word) {
    return [
      [/^凭据：(.+)$/, (m) => `Credentials: ${word(m[1])}`],
      [/^SN：(.+)$/, (m) => `SN: ${m[1]}`],
      [/^· (.+)$/, (m) => `· ${word(m[1])}`],

      [/^(\d+) 个标签(?: · (\d+) 就绪)?$/, (m) =>
        m[2] === undefined ? `${m[1]} tabs` : `${m[1]} tabs · ${m[2]} ready`],
      [/^(\d+) 失败$/, '$1 failed'],
      [/^扫描中 (\d+)\/(\d+) · 已发现 (\d+) 台$/, 'Scanning $1/$2 · $3 found'],
      [/^完成，发现 (\d+) 台$/, 'Done, $1 hosts found'],
      [/^失败：(.+)$/, (m) => `Failed: ${word(m[1])}`],
      [/^连接选中 \((\d+)\)$/, 'Connect selected ($1)'],
      [/^广播中 · (\d+) 个目标$/, 'Broadcasting · $1 targets'],
      [/^(\d+) 分钟前$/, '$1 min ago'],
      [/^(\d+) 小时前$/, '$1 h ago'],
      [/^(\d+) 天前$/, '$1 d ago'],
      [/^主题：(.+)$/, (m) => `Theme: ${word(m[1])}`],

      [/^执行完成：(\d+)\/(\d+) 台成功$/, 'Done: $1/$2 succeeded'],
      [/^已发送 (.+) 到 (\d+)\/(\d+) 台$/, (m) => `Sent ${word(m[1])} to ${m[2]}/${m[3]}`],
      [/^已发送到 (\d+)\/(\d+) 台$/, 'Sent to $1/$2'],
      [/^已挂载 (\d+)\/(\d+) 台(：(.+))?$/, (m) =>
        `Mounted $1/$2${m[4] ? `: ${word(m[4])}` : ''}`],
      [/^已卸载 (\d+)\/(\d+) 台$/, 'Unmounted $1/$2'],
      [/^已重连 (\d+)\/(\d+) 台$/, 'Reconnected $1/$2'],
      [/^已重置 (\d+)\/(\d+) 台$/, 'Reset $1/$2'],
      [/^已连接 (\d+)\/(\d+) 台$/, 'Connected $1/$2'],
      [/^还有 (\d+) 台默认凭据不可用，请补充密码$/,
        '$1 more hosts have no working default credentials; enter a password.'],
      [/^将清除 (\d+) 台服务器在本机保存的凭据、Cookie 和连接缓存，确定继续？$/,
        'This clears saved credentials, cookies and connection cache for $1 servers. Continue?'],
      [/^已删除 (\d+) 台$/, 'Deleted $1'],

      [/^已清理 (\d+) 个 iDRAC 会话$/, 'Cleared $1 iDRAC sessions'],
      [/^未找到 (.+) 许可文件（目录：(.+)）$/, 'No $1 license file found (looked in: $2)'],
      [/^已导入试用许可：(.+)$/, 'Trial license imported: $1'],
      [/^已移除旧许可并导入：(.+)$/, 'Old license removed and imported: $1'],
      [/^试用许可导入失败：(.+?)(（.+）)?$/, 'Trial license import failed: $1$2'],
      [/^已导入许可：(.+)$/, 'License imported: $1'],
      [/^许可导入失败：(.+)$/, (m) => `License import failed: ${word(m[1])}`],

      [/^已挂载 (.+)（(.+)）(，并设置下次从光驱启动)?$/, (m) =>
        `Mounted ${m[1]} (${m[2]})${m[3] ? '; boots from CD/DVD next time' : ''}`],
      [/^Redfish 挂载失败：(.+)$/, 'Redfish mount failed: $1'],
      [/^卸载失败：(.+)$/, 'Eject failed: $1'],
      [/^不是文件：(.+)$/, 'Not a file: $1'],
      [/^请求超时（(\d+)ms）$/, 'Request timed out ($1 ms)'],
      [/^Redfish 资源不存在：(.+)$/, 'Redfish resource not found: $1'],
      [/^Redfish 请求失败 HTTP (\d+)：(.+)$/, 'Redfish request failed (HTTP $1): $2'],
      [/^Redfish 返回非 JSON：(.+)$/, 'Redfish returned non-JSON: $1'],
      [/^挂载失败 HTTP (\d+)(：(.+))?$/, (m) => `Mount failed (HTTP ${m[1]})${m[3] ? `: ${m[3]}` : ''}`],
      [/^挂载失败：(.+)$/, 'Mount failed: $1'],
      [/^卸载失败 HTTP (\d+)$/, 'Eject failed (HTTP $1)'],
      [/^设置启动项失败 HTTP (\d+)$/, 'Setting the boot device failed (HTTP $1)'],
      [/^电源操作失败 HTTP (\d+)$/, 'Power action failed (HTTP $1)'],
      [/^无效网段：(.+)$/, 'Invalid subnet: $1'],

      [/^下载保存失败：(.+)$/, 'Download could not be saved: $1'],
      [/^页面加载失败：(.+) \((-?\d+)\)$/, 'Page failed to load: $1 ($2)'],
      [/^打开失败：(.+) \((\d+)\)$/, 'Failed to open: $1 ($2)'],
      [/^页面加载超时（25s）$/, 'Page load timed out (25 s)'],
      [/^连接中断，正在自动恢复（(\d+)\/2）$/, 'Connection lost; recovering automatically ($1/2)'],
      [/^VNC 启用失败：(.+)$/, (m) => `Could not enable VNC: ${word(m[1])}`],
      [/^VNC 已配置但端口 (\d+) 未监听$/, 'VNC is configured but port $1 is not listening'],
      [/^(.+)，正在重新登录$/, (m) => `${word(m[1])}; signing in again`],
      [/^iDRAC 会话数已满，自动清理失败：(.+)$/,
        (m) => `All iDRAC sessions are in use and cleanup failed: ${word(m[1])}`],
      [/^登录失败：(.+)$/, 'Sign-in failed: $1'],
      [/^控制台连接失败：(.+)$/, 'Console connection failed: $1'],
      [/^KVM 入口未找到：(.+)$/, (m) => `KVM entry not found: ${word(m[1])}`],
      [/^虚拟控制台不可用：(.+)$/, (m) => `Virtual console unavailable: ${word(m[1])}`],
      [/^与「(.+)」冲突$/, 'Conflicts with "$1"'],
      [/^已发送 (.+)$/, (m) => `Sent ${word(m[1])}`],
      [/^已打开厂商虚拟介质面板(?: · (.+))?$/, (m) =>
        `Opened the vendor virtual media panel${m[1] ? ` · ${m[1]}` : ''}`],
      [/^已通过本地上传挂载 (.+)$/, 'Mounted via local upload: $1'],
      [/^第 (\d+) 行：需要 name,host,vendor,username,password$/,
        'Line $1: expected name,host,vendor,username,password'],
      [/^第 (\d+) 行：未知厂商 (.+)$/, 'Line $1: unknown vendor $2'],
      [/^退出码 (\d+)$/, 'Exit code $1'],
    ];
  }

  function createTranslator(messages, makePatterns) {
    const hasOwn = Object.prototype.hasOwnProperty;
    const exact = (text) => (hasOwn.call(messages, text) ? messages[text] : null);
    const word = (text) => {
      const hit = exact(String(text).trim());
      return hit == null ? text : hit;
    };
    const patterns = makePatterns(word);
    const lookup = (core) => {
      const hit = exact(core);
      if (hit != null) return hit;
      for (let i = 0; i < patterns.length; i += 1) {
        const rx = patterns[i][0];
        const rep = patterns[i][1];
        if (!rx.test(core)) continue;
        const m = rx.exec(core);
        return typeof rep === 'function' ? rep(m, word) : core.replace(rx, rep);
      }
      return null;
    };
    const translate = (text) => {
      if (!text || !hasCjk(text)) return text;
      const parts = /^(\s*)([\s\S]*?)(\s*)$/.exec(text);
      if (!parts || !parts[2]) return text;
      const hit = lookup(parts[2]);
      return hit == null ? text : parts[1] + hit + parts[3];
    };
    translate.lookup = lookup;
    return translate;
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { MESSAGES, makePatterns, createTranslator, hasCjk, fill };
    return;
  }

  const langMode = () => localStorage.getItem('kvm-lang') || 'auto';
  const systemLang = () => {
    const tag = ((navigator.languages && navigator.languages[0]) || navigator.language || '').toLowerCase();
    return tag.startsWith('zh') ? 'zh' : 'en';
  };
  const active = () => {
    const mode = langMode();
    return mode === 'zh' || mode === 'en' ? mode : systemLang();
  };

  const translate = createTranslator(MESSAGES, makePatterns);
  const misses = new Set();
  const t = (text, params) => fill(active() === 'en' ? translate(text) : text, params);

  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'PRE', 'CODE', 'TEXTAREA']);
  const insideSkipped = (node) => {
    for (let n = node; n && n.nodeType; n = n.parentNode) {
      if (n.nodeType === 1 && (SKIP_TAGS.has(n.tagName) || n.hasAttribute('data-no-i18n'))) return true;
    }
    return false;
  };

  const visit = (node) => {
    if (node.nodeType === 3) {
      const text = node.nodeValue || '';
      if (!hasCjk(text) || insideSkipped(node.parentNode)) return;
      const next = translate(text);
      if (next === text) misses.add(text.trim());
      else node.nodeValue = next;
      return;
    }
    if (node.nodeType !== 1) return;
    // Attributes still translate on skipped elements: a textarea or pre may
    // keep its text verbatim while carrying a translatable placeholder.
    for (const attr of ['placeholder', 'title', 'aria-label']) {
      const value = node.getAttribute(attr);
      if (!value || !hasCjk(value)) continue;
      const next = translate(value);
      if (next === value) misses.add(value.trim());
      else node.setAttribute(attr, next);
    }
    if (SKIP_TAGS.has(node.tagName) || node.hasAttribute('data-no-i18n')) return;
    for (const child of node.childNodes) visit(child);
  };

  let scheduled = false;
  const apply = () => {
    if (scheduled || active() !== 'en') return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      visit(document.body);
    });
  };

  window.i18n = {
    active,
    t,
    translate,
    apply,
    misses: () => [...misses],
  };
  window.__i18n = window.i18n;

  document.addEventListener('DOMContentLoaded', () => {
    apply();
    if (active() === 'en') {
      new MutationObserver(apply).observe(document.body, {
        childList: true,
        subtree: true,
        characterData: true,
      });
    }
  });
})();
