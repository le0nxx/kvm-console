export type VendorId = 'huawei' | 'xfusion' | 'dell' | 'inspur' | 'generic';
export type Scheme = 'http' | 'https';
export type SessionState = 'idle' | 'loading' | 'login' | 'kvm' | 'ready' | 'manual' | 'error';

export type UiMode = 'grid' | 'focus' | 'launcher' | 'connect' | 'history' | 'scan' | 'media' | 'input';

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Device {
  id: string;
  /** optional label; devices are usually identified by IP */
  name?: string;
  vendor: VendorId;
  model?: string;
  host: string;
  port: number;
  scheme: Scheme;
  username: string;
  /** sealed secret: base64 of safeStorage blob, or base64 of utf8 when enc=plain */
  secret: string;
  enc: 'safe' | 'plain';
  kvmUrl?: string;
  note?: string;
  serial?: string;
  mode?: 'web' | 'vnc';
  vncPassword?: string;
  vnc?: { enabled: boolean; port: number; verifiedAt: number };
  license?: { state: 'ok' | 'activated' | 'none' | 'failed'; note: string };
  createdAt: number;
  lastUsedAt?: number;
  useCount?: number;
  /** tab is open (restored on next launch) */
  open?: boolean;
  pinned?: boolean;
  /** transient connection, never written to disk */
  ephemeral?: boolean;
}

export interface DeviceInput {
  id?: string;
  name?: string;
  vendor: VendorId;
  model?: string;
  host: string;
  port?: number;
  scheme?: Scheme;
  username: string;
  /** plaintext password; empty string on edit means "keep existing" */
  password?: string;
  kvmUrl?: string;
  note?: string;
  serial?: string;
  mode?: 'web' | 'vnc';
}

export interface PublicDevice {
  id: string;
  name?: string;
  vendor: VendorId;
  model?: string;
  host: string;
  port: number;
  scheme: Scheme;
  username: string;
  kvmUrl?: string;
  note?: string;
  serial?: string;
  vncPassword?: string;
  vnc?: { enabled: boolean; port: number; verifiedAt: number };
  license?: { state: 'ok' | 'activated' | 'none' | 'failed'; note: string };
  hasPassword: boolean;
  createdAt: number;
  lastUsedAt?: number;
  useCount: number;
  open: boolean;
  ephemeral: boolean;
}

export interface DownloadEvent {
  name: string;
  path: string;
  state: 'started' | 'progress' | 'done' | 'error';
  received: number;
  total: number;
  error?: string;
}

export interface SessionSnapshot {
  id: string;
  name: string;
  vendor: VendorId;
  model?: string;
  host: string;
  state: SessionState;
  detail: string;
  serial?: string;
  vncPassword?: string;
  vnc?: { enabled: boolean; port: number; verifiedAt: number };
  license?: { state: 'ok' | 'activated' | 'none' | 'failed'; note: string };
  external?: boolean;
  webOpen?: boolean;
  canvas?: { w: number; h: number };
  /** when the current connect attempt began, for the elapsed-time readout */
  startedAt?: number;
}

export interface VendorInfo {
  id: VendorId;
  label: string;
  hint: string;
  defaults: Array<{ u: string; p: string }>;
}

export interface ScanHost {
  ip: string;
  port?: number;
  scheme?: Scheme;
  mac?: string;
  vendor?: VendorId;
  vendorLabel?: string;
  model?: string;
  serial?: string;
  title?: string;
  redfish?: boolean;
  /** credentials that actually authenticated (only when Redfish is available) */
  credential?: { username: string; password: string };
  savedCredential?: boolean;
  saved?: boolean;
  savedUsername?: string;
  latencyMs?: number;
  error?: string;
}

export interface ScanState {
  running: boolean;
  subnet: string;
  scanned: number;
  total: number;
  hosts: ScanHost[];
  error?: string;
  startedAt?: number;
  finishedAt?: number;
}

export interface AppSnapshot {
  devices: PublicDevice[];
  sessions: SessionSnapshot[];
  mode: UiMode;
  focusId: string | null;
  media: Record<string, { inserted: boolean; image: string | null }>;
  layout: { cols: number; rows: number };
  vendors: VendorInfo[];
  scan: ScanState;
  app: {
    version: string;
    demo: boolean;
    encryption: 'safe' | 'plain';
    platform: string;
    hostname: string;
    subnets: Array<{ iface: string; cidr: string }>;
    nativeDark: boolean;
    broadcast: boolean;
    broadcastTargets: string[];
  };
}
