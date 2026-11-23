# 键鼠操作广播（暂缓，设计已定稿）

目标：在**同厂商、同型号**的多台 KVM 上，把主控窗口里的键盘/鼠标操作同步到其余目标机。
适用范围明确排除跨厂商映射，因此不需要维护全量键位表，但仍有三件事必须做对。

## 1. 链路

```
真实键鼠
  → 主控视图 preload（kvmTap）捕获 keydown/keyup/mousemove/mousedown/wheel
  → 归一化事件 { phase, hidUsage, code, key, vk, modifiers, u, v, buttons, wheel }
  → 主控自身照常处理（不拦截）
  → 广播组内每台目标：CDP Input.dispatchKeyEvent / dispatchMouseEvent
```

关键点：

- **注入必须走 CDP**（`webContents.debugger.sendCommand`），产生 `isTrusted=true` 的事件；DOM `dispatchEvent` 会被 KVM 前端丢弃。
- 注入前先给目标 canvas 发一次 `mousePressed/mouseReleased`，确保焦点在控制台画布上。
- 键盘以 `KeyboardEvent.code`（物理键位）映射 HID usage，不用 `key`，否则目标机 BIOS 键盘布局不同会整体错位。
- `Ctrl+Alt+Del`、`Alt+Tab`、Win 键浏览器层送不进去，调用厂商页面自带的“发送组合键”（适配器 `sendSpecial()`）。

## 2. 坐标

- **绝对鼠标是硬前提**。相对模式依赖 pointer lock，9 个视图不可能同时持有。
- 武装前逐台检测鼠标模式，相对模式的直接拒绝加入；全部不支持则降级为“仅键盘广播”。
- 坐标用远端画面归一化 `u/v ∈ [0,1]`，每台按自己的 canvas 矩形映射；分辨率不同仍能按比例对齐，但要在 UI 明示。
- 首次接入某型号做一次四点校准，把 `canvasRect` 与真实画面区域的 letterbox 偏移记进设备配置。

## 3. 安全（比功能更重要）

1. **武装是显式动作**：`Ctrl+Shift+B` 或按钮，武装后所有目标磁贴红框 + 顶部常驻红条“正在广播到 N 台”。
2. **预览墙**：武装前把目标当前画面并排展示，要求人眼确认“都在同一界面”。广播只在目标状态一致时才安全。
3. **急停**：连按三次 `Esc` 或 `Ctrl+Shift+Space`，立即解除并断开注入。
4. 切换磁贴、目标掉线、窗口失焦 → 自动解除。
5. `Ctrl+Alt+Del` / `F4` / 电源键等破坏性组合单独二次确认。
6. 逐台失败默认**中止整组**，高亮故障台，不允许“其余继续”。

## 4. 数据模型

```sql
broadcast_group(id, name, leader_id, member_ids_json, created_at)
```

不满足 `adapter_id + model` 一致的设备在 UI 上置灰并给出原因；固件不同只警告（注入走 CDP，不依赖 DOM）。

## 5. 实施顺序

| 阶段 | 内容 | 验收 |
|---|---|---|
| B1 | `kvmTap` preload + 主控事件采集（不发） | 事件序列与本地一致 |
| B2 | 键盘广播 + 特殊键映射 | 2 台同型号同时进 BIOS，按键一致 |
| B3 | 绝对鼠标广播 + 校准 | 2 台同型号点同一位置命中同一按钮 |
| B4 | 武装/预览墙/急停/失败中止 | 误触演练：3 次 Esc 内必须断开 |
| B5 | 分组持久化 + UI | 重启后组还在 |

预计 B1–B3 是主要工作量，风险集中在“目标机鼠标模式是否可切绝对”和“UEFI 下绝对鼠标是否生效”，建议先拿两台同型号真机验证再排期。
