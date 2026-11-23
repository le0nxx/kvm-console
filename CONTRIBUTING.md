# Contributing

感谢反馈和贡献。

## 提交 Issue

请说明：

- 操作系统、版本、安装方式；
- BMC 厂商、型号、固件版本；
- 复现步骤；
- 必要时提供脱敏后的日志。

不要提交密码、Cookie、完整序列号或可访问的管理地址。

## Pull Request

- 先开 Issue 讨论较大的改动；
- 不提交 `node_modules/`、`dist/`、`release/`、`.cache/`；
- 修改后至少执行：

```bash
npm test
npm run demo
```

- 涉及 BMC 登录/入口识别的改动，请说明测试过的真实机型与固件版本；
- 不引入遥测、远程上报或默认外联。
