export interface ShortcutDef {
  id: string;
  label: string;
  group: string;
  fallback: string;
}

export const SHORTCUT_DEFS: ShortcutDef[] = [
  { id: 'connect.new', label: '连接', group: '功能', fallback: 'Ctrl+Shift+N' },
  { id: 'launcher', label: '快速连接', group: '功能', fallback: 'Ctrl+Shift+T' },
  { id: 'panel.scan', label: '扫描网段', group: '功能', fallback: 'Ctrl+Shift+S' },
  { id: 'reconnect.panel', label: '重连', group: '功能', fallback: 'Ctrl+Shift+R' },
  { id: 'panel.input', label: '文本/快捷键', group: '功能', fallback: 'Ctrl+Shift+I' },
  { id: 'panel.media', label: '虚拟媒体', group: '功能', fallback: 'Ctrl+Shift+V' },
  { id: 'panel.terminal', label: '终端', group: '功能', fallback: 'Ctrl+Shift+X' },
  { id: 'panel.broadcast', label: '广播', group: '功能', fallback: 'Ctrl+Shift+B' },
  { id: 'panel.power', label: '电源', group: '功能', fallback: 'Ctrl+Shift+P' },
  { id: 'panel.settings', label: '设置', group: '功能', fallback: 'Ctrl+Shift+Alt+S' },
  { id: 'tab.prev', label: '上一个标签', group: '标签', fallback: 'Ctrl+Shift+Left' },
  { id: 'tab.next', label: '下一个标签', group: '标签', fallback: 'Ctrl+Shift+Right' },
  { id: 'tab.close', label: '关闭当前标签', group: '标签', fallback: 'Ctrl+Shift+W' },
  { id: 'app.quit', label: '退出应用', group: '应用', fallback: 'Ctrl+Q' },
  { id: 'mode.toggle', label: '切换聚焦/窗格', group: '视图', fallback: 'Ctrl+Shift+Space' },
  { id: 'panel.history', label: '历史记录', group: '面板', fallback: 'Ctrl+Shift+H' },
  { id: 'theme.toggle', label: '切换主题', group: '操作', fallback: '' },
];

const MOD_KEYS = new Set(['control', 'ctrl', 'shift', 'alt', 'meta', 'super', 'cmd', 'command']);

interface ParsedAccel {
  control: boolean;
  shift: boolean;
  alt: boolean;
  meta: boolean;
  key: string;
}

export function parseAccelerator(accel: string): ParsedAccel | null {
  const parts = accel
    .split('+')
    .map((p) => p.trim())
    .filter(Boolean);
  if (!parts.length) return null;
  const parsed: ParsedAccel = { control: false, shift: false, alt: false, meta: false, key: '' };
  for (const part of parts) {
    const lower = part.toLowerCase();
    if (MOD_KEYS.has(lower)) {
      if (lower === 'control' || lower === 'ctrl') parsed.control = true;
      else if (lower === 'shift') parsed.shift = true;
      else if (lower === 'alt') parsed.alt = true;
      else parsed.meta = true;
      continue;
    }
    parsed.key = normalizeKey(part);
  }
  return parsed.key ? parsed : null;
}

export function normalizeKey(key: string): string {
  if (key === ' ' || /^(space|spacebar)$/i.test(key.trim())) return ' ';
  const k = key.trim().toLowerCase();
  const map: Record<string, string> = {
    esc: 'escape',
    del: 'delete',
    left: 'arrowleft',
    right: 'arrowright',
    up: 'arrowup',
    down: 'arrowdown',
    spacebar: ' ',
    space: ' ',
    return: 'enter',
    plus: '+',
  };
  if (map[k]) return map[k];
  if (/^f\d{1,2}$/.test(k)) return k;
  return k;
}

/** Some layouts/IMEs report key="Unidentified"; derive the physical key from code. */
export function normalizeInputKey(key: string, code?: string): string {
  if (key && !/^unidentified$/i.test(key.trim())) return normalizeKey(key);
  const c = (code || '').trim();
  if (!c) return normalizeKey(key || '');
  if (/^Key[A-Z]$/i.test(c)) return c.slice(3).toLowerCase();
  if (/^Digit[0-9]$/i.test(c)) return c.slice(5);
  if (c === 'Space') return ' ';
  const map: Record<string, string> = {
    ArrowLeft: 'arrowleft', ArrowRight: 'arrowright', ArrowUp: 'arrowup', ArrowDown: 'arrowdown',
    Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\',
    Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/', Backquote: '`',
    Enter: 'enter', Tab: 'tab', Escape: 'escape', Backspace: 'backspace', Delete: 'delete',
    Insert: 'insert', Home: 'home', End: 'end', PageUp: 'pageup', PageDown: 'pagedown',
    ControlLeft: 'control', ControlRight: 'control', ShiftLeft: 'shift', ShiftRight: 'shift',
    AltLeft: 'alt', AltRight: 'alt', MetaLeft: 'meta', MetaRight: 'meta',
  };
  if (map[c]) return map[c];
  return normalizeKey(c);
}

export function matchShortcut(
  input: { control: boolean; shift: boolean; alt: boolean; meta: boolean; key: string; code?: string },
  accel: string,
): boolean {
  const parsed = parseAccelerator(accel);
  if (!parsed) return false;
  return (
    parsed.control === input.control &&
    parsed.shift === input.shift &&
    parsed.alt === input.alt &&
    parsed.meta === input.meta &&
    parsed.key === normalizeInputKey(input.key, input.code)
  );
}

export function defaultBindings(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const def of SHORTCUT_DEFS) out[def.id] = def.fallback;
  return out;
}
