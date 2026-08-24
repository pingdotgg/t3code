# Fork 自动化

本 fork 不复制上游的 PR、部署、移动端、预览和发布自动化。
[`.github/workflows/release.yml`](../../../.github/workflows/release.yml) 是唯一的 GitHub Actions 工作流。

每夜版在发布桌面产物前运行：

- `vp check`
- `vp run typecheck`
- `vp run test`
- `vp run release:smoke`

Pull Request 不会自动运行仓库 CI。贡献者应在本地运行与改动范围匹配的测试、lint 和类型检查，
维护者在 Review 时确认结果。

计划时间、产物、可选签名和手动验证方式参阅 [Fork 每夜版发布](./release.md)。
