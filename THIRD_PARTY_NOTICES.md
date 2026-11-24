# Third-Party Notices

KVM Console 使用以下开源组件。各组件的版权归其作者所有。

## noVNC

- 位置：`src/renderer/novnc/`
- 用途：VNC/RFB 渲染与输入
- 许可证：Mozilla Public License 2.0 (MPL-2.0)
- 项目：https://github.com/novnc/noVNC

修改或分发 `src/renderer/novnc/` 下的文件时，请遵守 MPL-2.0 的源码公开要求。

## ipmitool

- 位置：`vendor/win-tools/ipmitool.exe`
- 用途：Windows 版 IPMI 命令
- 许可证：BSD-style；详见 `vendor/win-tools/IPMITOOL_COPYING.txt`
- 项目：https://github.com/ipmitool/ipmitool
- Windows 构建来自 Dell iDRAC Tools 安装包，附带 Cygwin 运行库（见 `CYGWIN_LICENSE.txt`）。

## Dell racadm

- 位置：`vendor/win-tools/racadm.exe`
- 用途：Windows 版 iDRAC CLI
- 版权：Dell Inc.
- 许可：Dell iDRAC Tools EULA；仅随本应用分发，详见 `vendor/win-tools/RACADM_NOTICE.txt`。

## Electron

- 用途：桌面运行时与 Chromium
- 许可证：MIT
- 项目：https://github.com/electron/electron

## ws

- 用途：本地 WebSocket 到 VNC TCP 的桥接
- 许可证：MIT
- 项目：https://github.com/websockets/ws

## TypeScript / electron-builder

- 仅用于开发和构建
- 许可证：Apache-2.0 / MIT

## BMC 页面与厂商资源

本程序不打包、不再分发华为 iBMC、超聚变 iBMC、戴尔 iDRAC、浪潮 ISBMC 的网页资源；
这些页面由用户所连接的设备在运行时提供，版权归各厂商所有。
