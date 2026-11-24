# Windows BMC CLI tools

Bundled with the Windows package and copied to `resources/tools/win/`:

- `racadm.exe` + `libargtable64.dll` — Dell iDRAC Tools for Windows (Dell EULA).
- `ipmitool.exe` + Cygwin runtime DLLs — ipmitool 1.8.18 Dell package (BSD-style licence; see `IPMITOOL_COPYING.txt`).

`racadm` remains Dell proprietary software. The Windows build bundles it only
as part of the KVM Console application; redistribution is subject to Dell's
iDRAC Tools licence.
