# Windows 安装包

两条构建路线，产出的都是免签名的 x64 安装包；`electron-builder` 的 NSIS 是目前验证过的默认路线（Linux 上直接可构建，不需要 Wine）。

## 默认：electron-builder NSIS

```bash
npm run build
npx electron-builder --win
```

输出（`release/`）：

```text
KVM-Console-<version>-win-x64-setup.exe      # NSIS 安装器，可选安装目录
KVM-Console-<version>-win-x64-portable.exe   # 免安装单文件
KVM-Console-<version>-win-x64-setup.exe.blockmap
```

安装器选项（见 `package.json` 的 `build.nsis`）：

- `oneClick: false`，向导式安装，可选择安装目录；
- `perMachine: false`，默认装到当前用户 `%LOCALAPPDATA%\Programs\KVM Console`，不需要管理员权限；
- 创建桌面快捷方式与开始菜单快捷方式，名称 `KVM Console`。

只构建其中一个目标：

```bash
npx electron-builder --win nsis
npx electron-builder --win portable
npx electron-builder --win dir        # 只解包到 release/win-unpacked
```

> 注意：`--win portable nsis` 同时构建时，两种目标会互相覆盖同名文件；
> 本仓库已在 `build.nsis` / `build.portable` 里分别指定 `-setup` 与 `-portable` 文件名。

## 备选：Inno Setup

`build/installer.iss` 保留作为备选方案，适合需要更细的安装界面控制时使用。

```bash
npx electron-builder --win dir        # 先准备 release/win-unpacked
ISCC.exe build/installer.iss          # Windows 上编译
```

Linux 下需要 Wine 与 ISCC：

```bash
xvfb-run -a wine /path/to/ISCC.exe build/installer.iss
```

输出 `release/KVM-Console-<version>-win-x64-setup.exe`。该脚本同样使用
`PrivilegesRequired=lowest`，默认安装到 `%LOCALAPPDATA%\Programs\KVM Console`，
并提供「桌面快捷方式（默认不勾选）/ 开始菜单快捷方式（默认勾选）」任务页。

## 内置工具

`vendor/win-tools/` 通过 `extraResources` 打进安装包，运行时位于
`resources/tools/win/`（`racadm.exe`、`ipmitool.exe` 及其 Cygwin DLL）。

## 校验

```bash
sha256sum KVM-Console-<version>-win-x64-{setup,portable}.exe
```

## 签名

见 [Windows 签名](WINDOWS-SIGNING.md)。
