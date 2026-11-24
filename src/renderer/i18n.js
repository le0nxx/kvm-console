(() => {
  const DICT = {
    '多路控制台 · beta': 'Multi-console · beta', '多路控制台': 'Multi-console',
    '戴尔选 VNC 会占用虚拟控制台，Web KVM 将不可用。': 'Dell VNC occupies the virtual console; Web KVM will be blocked.',
    '凭据：不可用': 'Credentials: Unavailable', '凭据：未知': 'Credentials: Unknown',
    '凭据：默认': 'Credentials: Default', '凭据：已保存': 'Credentials: Saved',
    '默认凭据可用': 'Default credentials', '已保存凭据': 'Saved credentials', '已保存': 'Saved', '默认凭据': 'Default',
    'Redfish 可用 / 凭据未知': 'Redfish reachable / credentials unknown',
    'HTTP 可达': 'HTTP reachable', '未知设备': 'Unknown device',
    '文本预设（点击直接发送，可增删）': 'Text presets (click to send, add or remove)',
    '新增预设，例如 Admin@9000': 'New preset, e.g. Admin@9000', '添加': 'Add', '删除': 'Delete',
    '还没有预设': 'No presets yet', '点击填入': 'Click to fill',
    '广播': 'Broadcast', '启用广播': 'Start broadcast', '停止广播': 'Stop broadcast',
    '未启用': 'Off', '先勾选至少一个目标': 'Select at least one target', '键盘广播到所有窗格': 'Broadcast keyboard to all panes',
    '连接': 'Connect', '扫描网段': 'Scan subnet', '历史': 'History', '虚拟镜像': 'Virtual media', '虚拟媒体': 'Virtual Media', '终端': 'Terminal', '下载': 'Downloads', '打开目录': 'Open folder', '清空': 'Clear', '还没有下载': 'No downloads yet',
    '文本/快捷键': 'Text / Keys', '电源': 'Power', '全部重连': 'Reconnect all', '快速切换': 'Quick Connect', '快速连接': 'Quick Connect',
    '快捷键': 'Shortcuts', '设置': 'Settings', '自动': 'Auto', '日间': 'Light', '夜间': 'Dark',
    '跟随系统': 'System', '连接一台 BMC': 'Connect a BMC', '连接 BMC': 'Connect BMC',
    '填地址和密码直接连；不想要记录就点「仅连接」，关掉标签即消失。': 'Enter the address and password to connect. Use "Connect only" to skip history; closing the tab removes it.',
    '连接一台 BMC，或者扫描同网段自动发现。': 'Connect a BMC, or scan the local subnet to discover one.',
    '最近连接': 'Recent', '还没有历史连接': 'No history yet', '地址': 'Address', '地址（可选）': 'Address (optional)',
    '端口': 'Port', '协议': 'Scheme', '厂商': 'Vendor', '连接方式': 'Mode', '用户名': 'Username', '密码': 'Password',
    '备注名（可选）': 'Name (optional)', '不填就用 IP 显示': 'Defaults to the IP address',
    'KVM 地址（可选）': 'KVM URL (optional)', '自动识别失败时手填': 'Fill in if auto-detect fails',
    '留空则沿用历史密码': 'Leave blank to reuse the saved password', '自动（推荐）': 'Auto (recommended)',
    '仅连接（不记历史）': 'Connect only (no history)', '仅连接': 'Connect only', '重置输入': 'Reset form',
    '存为预设': 'Save preset', '恢复默认': 'Reset defaults', '取消': 'Cancel', '关闭': 'Close',
    '目标（可多选）': 'Targets (multi-select)', '全选': 'All', '清除': 'Clear', '重置': 'Reset',
    '勾选要接收键盘广播的目标，然后启用。广播只转发普通按键和 Shift 组合。':
      'Select the targets that should receive keyboard broadcasts, then start. Only normal keys and Shift combos are forwarded.',
    '通过 Redfish 发送；强制关机会立即断电。': 'Sent via Redfish; forced power off cuts power immediately.',
    '输入主机名 / IP / 厂商，回车直达…': 'Type hostname / IP / vendor, press Enter to connect...',
    '功能': 'Functions', '切换聚焦/窗格': 'Toggle Focus / Grid', '删除连接': 'Delete Connection', '已删除连接': 'Connection Deleted', '聚焦': 'Focus', '重连': 'Reconnect', '重连选中': 'Reconnect selected',
    '重置连接': 'Reset connection', '确认电源操作': 'Confirm power action', '确认发送': 'Send',
    '勾选要重连的服务器；重置会清除本机保存的凭据、Cookie 和连接缓存。':
      'Select servers to reconnect. Reset clears locally saved credentials, cookies and connection cache.', 'Redfish 可用': 'Redfish reachable', '开机': 'Power on', '软关机': 'Soft shutdown', '强制关机': 'Force off',
    '软重启': 'Soft restart', '强制重启': 'Force restart', '无凭据': 'No credentials',
    '连接选中': 'Connect selected', '没有已挂载的镜像': 'No mounted image',
    '设置下次从光驱启动': 'Boot from CD/DVD next time', '命令会在勾选的目标上逐台执行；凭据由本机连接记录提供。': 'Runs on each selected target; credentials come from local connection records.', '未选择文件': 'No file selected',
    '选择镜像': 'Select image', '挂载选中': 'Mount selected', '卸载选中': 'Unmount selected',
    '设置下次从光驱启动': 'Boot from CD/DVD next time', '命令会在勾选的目标上逐台执行；凭据由本机连接记录提供。': 'Runs on each selected target; credentials come from local connection records.', '未选择文件': 'No file selected',
    '常用快捷键（发送到选中）': 'Common keys (to selected)', '发送到选中': 'Send to selected',
    '粘贴要输入到 KVM 的文本（换行=Enter）': 'Text to send to the KVM (newline = Enter)',
    '点击右侧按键框后按下组合键；Esc 取消，退格清除': 'Click a key box, then press a shortcut. Esc cancels, Backspace clears.',
    '未绑定': 'Unbound', 'Web 控制台': 'Web console', 'VNC 控制台': 'VNC console',
    '正在打开管理页面': 'Opening the management page', '正在自动登录': 'Signing in automatically',
    '正在进入 KVM': 'Entering the KVM', '正在连接 iDRAC 控制台…': 'Connecting to the iDRAC console...',
    '连接 iDRAC 控制台超时': 'Timed out connecting to the iDRAC console', '正在重连全部标签…': 'Reconnecting all tabs...',
    '标签顺序已保存': 'Tab order saved', '没有已挂载的镜像': 'No mounted images',
    '正在扫描…': 'Scanning...', '系统钥匙串不可用，凭据将以 base64 明文保存在本机':
      'System keychain unavailable; credentials will be stored locally in base64.',
    '该设备默认凭据不可用，请补充用户名/密码': 'Default credentials failed; enter a username/password.',
    '先勾选至少一台服务器': 'Select at least one server.', '先输入或粘贴要发送的文本': 'Enter or paste text to send.',
    '地址不能为空': 'Address is required.', '请输入 BMC 地址': 'Enter a BMC address.',
    '请先填写密码，再上传许可': 'Enter the password before uploading a license.',
    '先在表单里填好 BMC 地址和用户名，再上传许可': 'Fill in the BMC address and username before uploading a license.',
    '会立即生效，确定发送到': 'This takes effect immediately. Send to', '正在扫描…': 'Scanning...', '开始扫描': 'Start scan', '取消扫描': 'Cancel scan',
    '扫描本网段': 'Scan local subnet', '网段': 'Subnet', '连接选中': 'Connect selected',
    '还没有结果，输入网段后点“开始扫描”': 'No results yet. Enter a subnet and start scanning.',
    '完成，发现': 'Done, found', '台': 'hosts', '个标签': 'tabs', '就绪': 'ready',
    '没有打开的会话': 'No open sessions', '正在打开': 'Opening', '正在登录': 'Signing in',
    '正在进入 KVM': 'Entering KVM', '正在连接…': 'Connecting...', '在线': 'Online', '离线': 'Offline',
    '已完成': 'Done', '正在扫描': 'Scanning', '已连接': 'Connected', '已断开': 'Disconnected',
    '就绪': 'Ready', '错误': 'Error', '手动': 'Manual', '未知': 'Unknown', '删除': 'Delete',
    '打开': 'Open', '重连': 'Reconnect', '导入许可': 'Import license', '显示控制台': 'Show console',
    '关闭标签': 'Close tab', '已打开': 'Open', '手动上传许可': 'Upload license manually',
    '虚拟控制台/虚拟介质需要 Enterprise 许可证': 'Virtual console and virtual media require an Enterprise license',
    '华为 iBMC 与超聚变 iBMC 同源，KVM 入口通常在“远程控制”下':
      'Huawei iBMC and xFusion iBMC share the same codebase; the KVM entry is usually under Remote Control.',
    '型号与固件差异较大，必要时在设备里手填 KVM 地址':
      'Models and firmware vary widely; fill in the KVM URL manually if auto-detect fails.',
    '使用通用登录与入口识别，失败时可手动操作或填 KVM 地址':
      'Uses generic login and console detection; if it fails, operate manually or set the KVM URL.',
    'iDRAC 许可文件': 'iDRAC license file',
    '拖拽 .xml 许可到这里，或点击选择': 'Drop the .xml license here, or click to choose',
    '主题：跟随系统（点击切换日间）': 'Theme: System (click for light)',
    '主题：日间（点击切换夜间）': 'Theme: Light (click for dark)',
    '主题：夜间（点击恢复跟随系统）': 'Theme: Dark (click for system)',
    '已挂载': 'Mounted', '未挂载': 'Not mounted', '已卸载': 'Unmounted', '可用 / 凭据未知': 'Reachable / credentials unknown',
    '可达': 'Reachable', '不可达': 'Unreachable', '失败': 'Failed', '完成': 'Done', '正在导入许可…': 'Importing license...',
    '许可已导入': 'License imported', '许可导入失败': 'License import failed', '华为 / 超聚变': 'Huawei / xFusion',
    '戴尔 iDRAC': 'Dell iDRAC', '浪潮 ISBMC': 'Inspur ISBMC', '通用 / 其他': 'Generic / Other',
    '搜索': 'Search', '设置语言': 'Language', '主题': 'Theme', '语言': 'Language',
    '设置': 'Settings', '自动（跟随系统）': 'Auto (system)', '日间': 'Light', '夜间': 'Dark',
    '标签': 'Tabs', '应用': 'Application', '视图': 'View', '面板': 'Panels', '操作': 'Actions',
    '上一个标签': 'Previous tab', '下一个标签': 'Next tab', '关闭当前标签': 'Close current tab',
    '新建连接': 'New connection', '退出应用': 'Quit application', '切换到网格': 'Switch to grid',
    '聚焦当前标签': 'Focus current tab', '扫描网段': 'Scan subnet', '历史记录': 'History',
    '虚拟镜像': 'Virtual media', '虚拟媒体': 'Virtual Media', '终端': 'Terminal', '下载': 'Downloads', '打开目录': 'Open folder', '清空': 'Clear', '还没有下载': 'No downloads yet', '文本 / 快捷键': 'Text / Shortcuts', '电源控制': 'Power control',
    '快速切换': 'Quick Connect', '快速连接': 'Quick Connect', '全部重连': 'Reconnect all', '切换主题': 'Toggle theme',
    '恢复默认': 'Reset defaults', '未绑定': 'Unbound',
    'English': 'English', '跟随系统语言': 'System language',
  };
  const RULES = [
    [/^(\d+) 个标签 · (\d+) 就绪$/, '$1 tabs · $2 ready'],
    [/^扫描中 (\d+)\/(\d+) · 已发现 (\d+) 台$/, 'Scanning $1/$2 · $3 found'],
    [/^完成，发现 (\d+) 台$/, 'Done, $1 hosts found'],
    [/^已连接 (\d+)\/(\d+) 台$/, 'Connected $1/$2'],
    [/^已挂载 (\d+)\/(\d+) 台/, 'Mounted $1/$2'],
    [/^已卸载 (\d+)\/(\d+) 台$/, 'Unmounted $1/$2'],
    [/^(\d+) 分钟前$/, '$1 min ago'],
    [/^(\d+) 小时前$/, '$1 h ago'],
    [/^(\d+) 天前$/, '$1 d ago'],
    [/^SN：/, 'SN:'],
    [/^刚刚$/, 'just now'],
    [/^从未$/, 'never'],
  ];
  const langMode = () => localStorage.getItem('kvm-lang') || 'auto';
  const PRESERVE = new Set(['xFusion', 'iDRAC', 'iBMC', 'macOS', 'KVM', 'VNC', 'SN', 'IPMI', 'HTTP', 'HTTPS', 'Redfish', 'NMI', 'USB']);
  const titleCase = (text) => {
    const s = text.trim();
    if (!s || s.length > 48 || /[.!?]\s*$/.test(s)) return text;
    return text.replace(/\b[a-z][A-Za-z0-9]*\b/g, (w) => {
      if (PRESERVE.has(w)) return w;
      return w[0].toUpperCase() + w.slice(1);
    });
  };
  const active = () => {
    const mode = langMode();
    if (mode === 'zh' || mode === 'en') return mode;
    return (navigator.language || '').toLowerCase().startsWith('zh') ? 'zh' : 'en';
  };
  const tr = (text) => {
    if (active() !== 'en') return text;
    let out = text;
    for (const zh of Object.keys(DICT).sort((a, b) => b.length - a.length)) {
      if (out.includes(zh)) out = out.split(zh).join(DICT[zh]);
    }
    for (const [re, rep] of RULES) if (re.test(out.trim())) out = out.replace(re, rep);
    return titleCase(out);
  };
  const visit = (node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const next = tr(node.nodeValue || '');
      if (next !== node.nodeValue) node.nodeValue = next;
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    for (const attr of ['placeholder', 'title', 'aria-label']) {
      const v = node.getAttribute(attr);
      if (v) {
        const next = tr(v);
        if (next !== v) node.setAttribute(attr, next);
      }
    }
    for (const child of node.childNodes) visit(child);
  };
  let dirty = false;
  const apply = () => {
    if (dirty) return;
    dirty = true;
    requestAnimationFrame(() => {
      dirty = false;
      visit(document.body);
    });
  };
  document.addEventListener('DOMContentLoaded', () => {
    apply();
    if (active() === 'en') {
      new MutationObserver(apply).observe(document.body, { childList: true, subtree: true, characterData: true });
    }
  });
  window.__i18n = { active, tr, apply };
})();
