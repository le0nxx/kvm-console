import { app } from 'electron';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export type BmcTool = 'racadm' | 'ipmitool';

export interface ToolTarget {
  host: string;
  username: string;
  password: string;
}

export interface ToolResult {
  ok: boolean;
  code: number | null;
  output: string;
  error?: string;
}

/** Quote-aware split for CLI text. Never goes through a shell. */
export function tokenizeCommand(input: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === '\\' && i + 1 < input.length) cur += input[++i];
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (cur) out.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (quote) throw new Error('命令引号未闭合');
  if (cur) out.push(cur);
  return out;
}

function executable(tool: BmcTool): string {
  const exe = process.platform === 'win32' ? `${tool}.exe` : tool;
  const roots = app.isPackaged
    ? [path.join(process.resourcesPath, 'tools', 'win'), path.join(process.resourcesPath, 'tools')]
    : [path.join(app.getAppPath(), 'vendor', 'win-tools'), path.join(app.getAppPath(), 'vendor')];
  for (const root of roots) {
    const candidate = path.join(root, exe);
    if (fs.existsSync(candidate)) return candidate;
  }
  // Linux/macOS dev or packaged-with-system-tools fallback.
  return exe;
}

export function toolsAvailable(): Record<BmcTool, boolean> {
  const result = {} as Record<BmcTool, boolean>;
  for (const tool of ['racadm', 'ipmitool'] as BmcTool[]) {
    const exe = executable(tool);
    if (path.isAbsolute(exe)) result[tool] = fs.existsSync(exe);
    else result[tool] = process.platform !== 'win32';
  }
  return result;
}

export function runBmcTool(tool: BmcTool, target: ToolTarget, command: string, timeoutMs = 60000): Promise<ToolResult> {
  return new Promise((resolve) => {
    let args: string[];
    try {
      const parts = tokenizeCommand(command);
      if (!parts.length) {
        resolve({ ok: false, code: null, output: '', error: '命令为空' });
        return;
      }
      args = tool === 'racadm'
        ? ['-r', target.host, '-u', target.username, '-p', target.password, ...parts]
        : ['-I', 'lanplus', '-H', target.host, '-U', target.username, '-P', target.password, ...parts];
    } catch (err) {
      resolve({ ok: false, code: null, output: '', error: err instanceof Error ? err.message : String(err) });
      return;
    }

    let child;
    try {
      child = spawn(executable(tool), args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      resolve({ ok: false, code: null, output: '', error: err instanceof Error ? err.message : String(err) });
      return;
    }

    let out = '';
    let err = '';
    let done = false;
    const append = (chunk: Buffer) => {
      if (out.length < 200_000) out += chunk.toString();
    };
    const finish = (result: ToolResult) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(result);
    };
    child.stdout?.on('data', append);
    child.stderr?.on('data', (chunk: Buffer) => {
      if (err.length < 200_000) err += chunk.toString();
    });
    child.on('error', (e) => finish({ ok: false, code: null, output: out + err, error: e.message }));
    child.on('close', (code) => finish({
      ok: code === 0,
      code,
      output: out + err,
      error: code === 0 ? undefined : err.trim() || `退出码 ${code}`,
    }));
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* ignore */ }
      finish({ ok: false, code: null, output: out + err, error: '命令超时（60 秒）' });
    }, timeoutMs);
  });
}
