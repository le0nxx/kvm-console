import { contextBridge, ipcRenderer, webUtils } from 'electron';

const api = {
  snapshot: () => ipcRenderer.invoke('app:snapshot'),
  onDownload: (cb: (event: unknown) => void) => {
    ipcRenderer.on('download', (_e, event) => cb(event));
  },
  onState: (cb: (state: unknown) => void) => {
    const handler = (_event: unknown, state: unknown) => cb(state);
    ipcRenderer.on('state', handler);
    return () => ipcRenderer.removeListener('state', handler);
  },
  onScan: (cb: (scan: unknown) => void) => {
    const handler = (_event: unknown, scan: unknown) => cb(scan);
    ipcRenderer.on('scan:update', handler);
    return () => ipcRenderer.removeListener('scan:update', handler);
  },

  connect: (input: unknown) => ipcRenderer.invoke('session:connect', input),
  closeSession: (id: string) => ipcRenderer.invoke('session:close', id),
  openHistory: (id: string) => ipcRenderer.invoke('history:open', id),
  removeHistory: (id: string) => ipcRenderer.invoke('history:remove', id),
  reconnect: (id: string) => ipcRenderer.invoke('sessions:reconnect', id),
  focusConsole: (id: string) => ipcRenderer.invoke('sessions:focusConsole', id),
  reconnectAll: () => ipcRenderer.invoke('sessions:reconnectAll'),
  resetConnection: (id: string) => ipcRenderer.invoke('session:resetConnection', id),

  setMode: (mode: string, focusId?: string | null) => ipcRenderer.invoke('ui:mode', mode, focusId ?? null),
  reorder: (ids: string[]) => ipcRenderer.invoke('sessions:reorder', ids),
  setPanel: (next: { side?: string; panel?: string } | null) => ipcRenderer.invoke('ui:panel', next),
  onPanel: (cb: (payload: { dockOpen?: boolean; side?: string | null; panel?: string | null; targets?: string[]; prefill?: unknown }) => void) => {
    ipcRenderer.on('panel-state', (_e, payload) => cb(payload));
  },
  power: (id: string, action: string) => ipcRenderer.invoke('power:action', { id, action }),
  onShortcut: (cb: (name: string) => void) => {
    ipcRenderer.on('shortcut', (_e, name: string) => cb(name));
  },
  passwordFor: (host: string, port?: number) => ipcRenderer.invoke('device:password', { host, port }),
  toggleWeb: (id: string) => ipcRenderer.invoke('session:web', id),
  showWeb: (id: string) => ipcRenderer.invoke('session:showWeb', id),
  focusKvm: (id: string) => ipcRenderer.invoke('session:kvm', id),
  shortcutsGet: () => ipcRenderer.invoke('shortcuts:get'),
  shortcutsSet: (id: string, accel: string) => ipcRenderer.invoke('shortcuts:set', id, accel),
  shortcutsReset: () => ipcRenderer.invoke('shortcuts:reset'),
  shortcutsCapture: (on: boolean) => ipcRenderer.invoke('shortcuts:capture', on),
  reloadUi: () => ipcRenderer.invoke('ui:reload'),
  setBroadcast: (args: { on: boolean; targets?: string[] }) => ipcRenderer.invoke('ui:broadcast', args),
  typeText: (id: string, text: string) => ipcRenderer.invoke('session:typeText', id, text),
  toolsAvailable: () => ipcRenderer.invoke('tools:available'),
  openDownloadsFolder: () => ipcRenderer.invoke('downloads:openFolder'),
  openDownload: (target: string) => ipcRenderer.invoke('downloads:open', target),
  runTool: (id: string, tool: 'racadm' | 'ipmitool', command: string) =>
    ipcRenderer.invoke('tools:run', id, tool, command),
  combo: (id: string, keys: string[]) => ipcRenderer.invoke('session:combo', id, keys),
  setLayout: (cols: number, rows: number) => ipcRenderer.invoke('ui:layout', cols, rows),
  setGrid: (rect: { x: number; y: number; width: number; height: number }) => ipcRenderer.send('ui:grid', rect),

  scanStart: (cidr: string) => ipcRenderer.invoke('scan:start', cidr),
  scanCancel: () => ipcRenderer.invoke('scan:cancel'),

  pickIso: () => ipcRenderer.invoke('media:pick'),
  mount: (id: string, file: string, bootOnce: boolean) =>
    ipcRenderer.invoke('media:mount', { id, file, bootOnce }),
  eject: (id: string) => ipcRenderer.invoke('media:eject', id),
  refreshMedia: () => ipcRenderer.invoke('media:status'),
  openMediaPanel: (id: string) => ipcRenderer.invoke('media:openPanel', id),
  pickLicense: () => ipcRenderer.invoke('license:pick'),
  installLicense: (id: string, file: string) => ipcRenderer.invoke('license:install', { id, file }),
  uploadLicense: (args: {
    host: string;
    port?: number;
    scheme?: string;
    username: string;
    password: string;
    file: string;
  }) => ipcRenderer.invoke('license:upload', args),
  pathForFile: (file: File) => webUtils.getPathForFile(file),
  openUserData: () => ipcRenderer.invoke('app:userData'),
};

contextBridge.exposeInMainWorld('kvm', api);
export type KvmApi = typeof api;
