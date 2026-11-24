# Windows BMC CLI tools

Place the vendor-provided Windows binaries here before building the Windows package:

- `racadm.exe` — from Dell iDRAC Tools for Microsoft Windows Server
- `ipmitool.exe` — Windows build of ipmitool

They are copied to `resources/tools/win/` by electron-builder and used by the
Terminal panel. Dell's `racadm.exe` is proprietary; it is not redistributed by
this repository. The MIT-licensed source of KVM Console does not include these
binaries.
