# Windows 安装器

安装器使用 Inno Setup，脚本在 `build/installer.iss`。

## 构建

先准备 Windows 解包目录：

```bash
npx electron-builder --win portable
# 或先构建 win-unpacked
npx electron-builder --win dir
```

然后用 Inno Setup 编译：

```bash
ISCC.exe build/installer.iss
```

Linux 下可用 Wine：

```bash
xvfb-run -a wine /path/to/ISCC.exe build/installer.iss
```

输出：

```text
release/KVM-Console-<version>-win-x64-setup.exe
```

## 快捷方式选项

安装器提供任务页：

- `Create a desktop shortcut`：默认不勾选；
- `Create a Start Menu shortcut`：默认勾选。

用户可自行取消/勾选，不会强制创建桌面图标。

## 安装范围

`PrivilegesRequired=lowest`，默认安装到当前用户：

```text
%LOCALAPPDATA%\Programs\KVM Console
```

不需要管理员权限。

## 签名

见 [Windows 签名](WINDOWS-SIGNING.md)。
