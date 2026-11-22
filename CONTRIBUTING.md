# Contributing

欢迎参与 AI Library Demo。这个项目是一个以图书馆业务为载体的 AI 原生企业框架参考实现，重点在**五层边界、Pi SDK 编排、DeepSeek 工具调用、RBAC、审批与审计**。

## 开发环境

- Node.js **26+**（使用 `node:sqlite`，低版本无法运行）
- pnpm 10+
- 一个可用的 `DEEPSEEK_API_KEY`（真实模型回归才需要；单元测试不需要）

```bash
git clone https://github.com/hao-wxf/ai-library-demo.git
cd ai-library-demo
pnpm install
cp .env.example .env      # Windows: copy .env.example .env
# 编辑 .env，填入自己的 DEEPSEEK_API_KEY
```

## 常用命令

```bash
pnpm check     # TypeScript 类型检查
pnpm test      # 单元测试（策略/知识/业务/认证，不需要外部 API）
pnpm start     # 启动 Web + API
pnpm smoke     # 真实 DeepSeek + RBAC 端到端回归（需服务已启动）
pnpm reset     # 清空本地数据和 Pi Agent 状态（先停服务）
```

## 分支与提交

1. Fork 本仓库，或从 `main` 拉一个分支；
2. 分支名建议：`feat/...`、`fix/...`、`docs/...`；
3. 提交前运行 `pnpm check && pnpm test`；
4. 变更涉及真实模型链路时，说明你跑了哪些场景；
5. 提交 PR，描述动机、变更点和验证方式。

## 不要提交

- `.env`、任何 API Key/Token；
- `data/*.sqlite*`（本地业务数据和 Pi 状态）；
- `temp/`、`node_modules/`、日志文件；
- 真实读者个人信息。

## 新增能力层工具的约定

1. 在 `packages/capability-sdk` 增加业务方法；
2. 在 `packages/contracts` 增加 `ToolContract`；
3. 在 `packages/policy-sdk` 增加/更新 `canUseTool` 角色授权；
4. 在 `packages/agent-sdk` 用 `defineTool` 暴露工具，写 Trace/Audit；
5. 写工具要明确副作用、幂等、审批策略；
6. 补测试，并更新 `docs/five-layers-pi-sdk.md`；
7. 工具名必须匹配 `^[a-zA-Z0-9_-]+$`，使用下划线，例如 `catalog_search`。

## 许可证

贡献即表示同意以 [MIT License](LICENSE) 授权。
