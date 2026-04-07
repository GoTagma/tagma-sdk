# tagma-sdk 测试样例

## 目录结构

```text
tests/
  cases/        # YAML 样例定义
  helpers/      # 供 command / hook / output_check 调用的小脚本
  workspaces/   # 每个样例各自的沙盒工作目录
  unit/         # 单元测试（bun test）
  run-sample.ts # 一键运行入口（支持 auto-approve）
```

## 运行方式

```bash
# 列出所有样例
bun tests/run-sample.ts --list

# 运行单个/多个样例
bun tests/run-sample.ts 01-command-smoke 02-manual-ignore

# 仅本地快速样例（不依赖外部 AI CLI）
bun tests/run-sample.ts --local

# 仅 AI 驱动样例（需要 claude-code / codex CLI 已登录）
bun tests/run-sample.ts --ai

# 全部样例
bun tests/run-sample.ts --all

# PipelineRunner + onEvent + abort 专项测试
bun tests/run-sample.ts --extras

# 单元测试
bun test
```

> `manual trigger` 默认由 `tests/run-sample.ts` 自动批准/拒绝，不会卡住。

## 样例列表

### 本地快速样例（`--local`）

| 样例 | 用途 | 预期结果 | 预计耗时 |
|---|---|---|---:|
| `01-command-smoke` | DAG、hooks、file trigger、`exit_code`/`file_exists`/`output_check` completion | 成功 | < 2s |
| `02-manual-ignore` | manual trigger、`task_failure` hook、`on_failure: ignore` | 整体失败（含一个故意失败任务），downstream 继续 | < 2s |
| `03-stopall-timeout` | `on_failure: stop_all`、task timeout | 整体失败（1 fail、1 skipped、1 timeout） | ~2s |
| `04-pipeline-timeout` | pipeline timeout、`pipeline_error` hook | 整体失败（pipeline timeout） | ~2s |
| `07-hook-gate-pipeline` | `pipeline_start` hook exit=1 阻止整个 pipeline | 整体失败（pipeline blocked） | < 1s |
| `08-hook-gate-task` | `task_start` hook 阻止单个 task，其余正常 | blocked=1, skipped=1, success=1 | < 1s |
| `09-skip-downstream` | 上游失败 → downstream skip（含跨 track independent） | failed=1, skipped=2, success=1 | < 1s |
| `10-manual-reject` | manual trigger 被 reject → task blocked | blocked=1 | < 1s |
| `11-manual-timeout` | manual trigger 无人审批 → trigger 自身超时 | timeout=1 | ~1s |
| `12-exit-code-variants` | `exit_code` completion: 数组匹配 + 非零失败 | success=1, failed=1 | < 1s |
| `13-file-exists-variants` | `file_exists` completion: 目录、大小、kind=any | 成功 | < 1s |
| `14-file-trigger-exists` | file trigger: 文件预先存在时 ready 触发 | 成功 | < 1s |
| `15-hook-array` | hook 配置为数组（多个 hook 串行执行） | 成功 | < 1s |
| `16-cwd-override` | task-level `cwd` 覆盖 | 成功 | < 1s |
| `18-signal-cancel` | 外部 AbortSignal 取消运行中任务 | timeout=2 | < 2s |
| `19-ignore-cross-track` | 跨 track 的 `on_failure: ignore` + `depends_on` | failed=1, success=1 | < 1s |
| `20-track-cwd` | track-level `cwd` 覆盖 | 成功 | < 1s |
| `22-file-trigger-change` | file trigger: 文件被覆盖/修改触发 change 路径 | 成功 | < 2s |

### AI 驱动样例（`--ai`）

| 样例 | 用途 | 预期结果 | 预计耗时 |
|---|---|---|---:|
| `05-claude-haiku` | `claude-code`(Haiku)、`static_context` middleware、`continue_from`、`agent_profile` | 成功 | ~20s |
| `06-codex-plugin` | `@tagma/driver-codex`、低等级推理、`continue_from` + output handoff | 成功 | ~30s |
| `17-track-middlewares` | track-level `static_context` middleware 被所有 task 继承 | 成功 | ~20s |

### 专项测试（`--extras`）

- **PipelineRunner smoke**: 验证 `start()`、`subscribe()`、`getStates()`、`status`、`runId`、event 序列
- **PipelineRunner abort**: 验证 `abort()` 能正确中止运行中任务

## 单元测试

```bash
bun test
```

| 文件 | 覆盖 |
|---|---|
| `unit/schema.test.ts` | YAML 解析、template expansion、config inheritance |
| `unit/dag.test.ts` | DAG 构建、拓扑排序、环检测 |
| `unit/validate-raw.test.ts` | RawPipelineConfig 结构校验 |
| `unit/config-ops.test.ts` | 配置 CRUD helpers |
| `unit/inheritance.test.ts` | Track → Task 属性继承 |
| `unit/driver-assembly.test.ts` | Driver plugin 组装、context 构建 |
| `unit/utils.test.ts` | 工具函数 |
| `unit/registry.test.ts` | Plugin registry: register / get / list / load / fake plugin |
| `unit/template-expansion.test.ts` | Template `use:` + `with:` 参数替换、depends_on/continue_from/output 改写、类型校验 |

## 每个工作区的输出位置

每个样例工作区运行后，常见产物会在：

- `.tagma/logs/`：SDK 运行日志
- `.tagma-tests/generated/`：command 任务生成的辅助文件
- `.tagma-tests/output/`：task `output:` 写出的输出
- `.tagma-tests/hook-events.log`：hook 事件记录

## 建议使用顺序

```bash
# 1. 先跑单元测试
bun test

# 2. 本地快速样例
bun tests/run-sample.ts --local

# 3. PipelineRunner 专项
bun tests/run-sample.ts --extras

# 4. AI 驱动样例（需要 CLI 登录）
bun tests/run-sample.ts --ai
```
