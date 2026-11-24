# Windows 代码签名

当前 Windows 构建未签名。开源项目最现实的两条路线：

1. **SignPath.io（开源项目免费）** — 推荐；
2. **Azure Trusted Signing** — 约 $10/月，需要企业实体；
3. 传统 OV/EV 证书 + PFX — 适合有证书的团队。

## 方案 A：SignPath（开源免费）

1. 打开 <https://signpath.io/>，申请 **SignPath Foundation**；
2. 提交仓库地址、许可证、项目说明，审核通过后创建：
   - Organization
   - Project
   - Signing Policy（例如 `release-signing`）
   - Artifact Configuration（匹配 `*.exe`）
3. 安装 SignPath GitHub App，允许它读取构建产物；
4. 在 GitHub 仓库 Secrets 中保存：
   - `SIGNPATH_API_TOKEN`
   - `SIGNPATH_ORGANIZATION_ID`
   - `SIGNPATH_PROJECT_SLUG`
   - `SIGNPATH_SIGNING_POLICY_SLUG`
5. 构建 Windows 包后，把 `release/*.exe` 作为 artifact 上传，再交给 SignPath 签名；
6. 下载签名后的文件，重新生成 `SHA256SUMS` 并发布。

示例 workflow 结构：

```yaml
name: windows-release
on:
  workflow_dispatch:
  push:
    tags: ['v*']

jobs:
  build:
    runs-on: windows-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npm ci
      - run: npm run build
      - run: npx electron-builder --win nsis portable
      - uses: actions/upload-artifact@v4
        with:
          name: windows-unsigned
          path: release/*.exe

  sign:
    needs: build
    runs-on: ubuntu-latest
    steps:
      - uses: actions/download-artifact@v4
        with:
          name: windows-unsigned
          path: release
      - uses: signpath/github-action-submit-signing-request@v1
        with:
          api-token: ${{ secrets.SIGNPATH_API_TOKEN }}
          organization-id: ${{ secrets.SIGNPATH_ORGANIZATION_ID }}
          project-slug: ${{ secrets.SIGNPATH_PROJECT_SLUG }}
          signing-policy-slug: ${{ secrets.SIGNPATH_SIGNING_POLICY_SLUG }}
          artifact-configuration-slug: exe
          input-artifact-path: release
          output-artifact-path: release-signed
          wait-for-completion: true
```

SignPath 的 Action 参数名以其当前文档为准；核心是“构建产物上传 → 签名请求 → 下载签名产物”。

## 方案 B：Azure Trusted Signing

先创建 Trusted Signing Account、Certificate Profile，并配置 Entra ID 认证。然后：

```json
{
  "build": {
    "win": {
      "azureSignOptions": {
        "publisherName": "Your Company",
        "endpoint": "https://xxx.codesigning.azure.net",
        "certificateProfileName": "kvm-console",
        "codeSigningAccountName": "your-signing-account"
      }
    }
  }
}
```

需要 Azure CLI 登录或环境变量凭据；electron-builder 会调用 Trusted Signing 工具。

## 方案 C：PFX 证书

购买 OV/EV 证书后，将 PFX 放仓库外：

```json
{
  "build": {
    "win": {
      "signtoolOptions": {
        "certificateFile": "/secure/kvm-console.pfx",
        "certificatePassword": "${env.CSC_KEY_PASSWORD}",
        "signingHashAlgorithms": ["sha256"],
        "rfc3161TimeStampServer": "http://timestamp.digicert.com",
        "publisherName": "Your Company"
      }
    }
  }
}
```

构建：

```bash
export CSC_LINK=/secure/kvm-console.pfx
export CSC_KEY_PASSWORD='...'
npx electron-builder --win nsis portable
```

## 验证

```powershell
signtool verify /pa /v .\KVM-Console-2.3.1-win-x64-setup.exe
Get-AuthenticodeSignature .\KVM-Console-2.3.1-win-x64-portable.exe
```

## 注意

- 必须加 RFC3161 时间戳，否则证书过期后签名失效；
- PFX、密码、SignPath token 不要提交到 Git；
- SmartScreen 信誉需要时间积累，签名不等于立即无警告；
- 不要用自签名证书发布给外部用户。

## Inno Setup 安装器签名

本项目 Windows 安装器使用 `build/installer.iss`。签名时在 `[Setup]` 增加：

```ini
SignTool=signtool
SignedUninstaller=yes
```

在 `[Setup]` 之外定义：

```ini
[Setup]
; ...
```

实际 Inno 的签名命令通过 `SignTool` 指令配置，例如：

```ini
[Setup]
SignTool=signtool sign /fd sha256 /tr http://timestamp.digicert.com /td sha256 /f "C:\secure\kvm-console.pfx" /p "$p" $f
```

`$f` 是待签名文件，`$p` 会提示输入证书密码。签名后重新运行 Inno 编译。

SignPath 的流程相同：先构建未签名安装器，再上传给 SignPath 签名。
