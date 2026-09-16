// config.ts 的离线单测：默认值、环境变量覆盖、非法值回退、优先级。
import { test } from "./harness.ts";
import { loadConfig } from "../src/config.ts";

/** 临时覆盖环境变量（测试后恢复原状，避免污染后续用例） */
function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/** 清空所有 CLINKAI_* 变量（保证"默认值"测试的纯净环境） */
const ALL_VARS = [
  "CLINKAI_BASE_URL", "CLINKAI_API_KEY", "CLINKAI_MODEL",
  "CLINKAI_MAX_ROUNDS", "CLINKAI_MAX_TOKENS", "CLINKAI_TEMP",
  "CLINKAI_CTX_BUDGET", "CLINKAI_TOOL_OUT", "CLINKAI_SESSIONS",
  "CLINKAI_WORKSPACE", "CLINKAI_VERBOSE",
];
function clearEnv(): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const k of ALL_VARS) {
    out[k] = undefined;
  }
  return out;
}

test("loadConfig：默认值对准本机 llama.cpp", (t) => {
  withEnv(clearEnv(), () => {
    const c = loadConfig({ workspace: "D:\\ws" });
    t.eq(c.baseUrl, "http://127.0.0.1:18080/v1", "默认端点应为本机");
    t.eq(c.model, "qwen3.8-27b-local", "默认模型");
    t.eq(c.maxRounds, 15, "默认轮数上限");
    t.eq(c.maxTokens, 32768, "默认每轮 token 上限（含思考，对齐模型最大输出 32768）");
    t.eq(c.temperature, 0.3);
    t.eq(c.ctxBudget, 90000);
    t.eq(c.toolOutLimit, 8192);
    t.eq(c.workspace, "D:\\ws");
  });
});

test("loadConfig：环境变量覆盖默认值", (t) => {
  withEnv({ CLINKAI_MAX_ROUNDS: "7", CLINKAI_MODEL: "other-model", CLINKAI_TEMP: "0.9" }, () => {
    const c = loadConfig({});
    t.eq(c.maxRounds, 7);
    t.eq(c.model, "other-model");
    t.eq(c.temperature, 0.9);
  });
});

test("loadConfig：非法环境变量回退默认（配置错误不炸启动）", (t) => {
  withEnv({ CLINKAI_MAX_ROUNDS: "abc", CLINKAI_TEMP: "99", CLINKAI_CTX_BUDGET: "-5", CLINKAI_MAX_TOKENS: "0" }, () => {
    const c = loadConfig({});
    t.eq(c.maxRounds, 15, "非数字回退默认");
    t.eq(c.temperature, 0.3, "越界温度回退默认");
    t.eq(c.ctxBudget, 90000, "负数预算回退默认");
    t.eq(c.maxTokens, 32768, "0 值回退默认");
  });
});

test("loadConfig：命令行覆盖优先级最高", (t) => {
  withEnv({ CLINKAI_MAX_ROUNDS: "3" }, () => {
    const c = loadConfig({ maxRounds: 7 });
    t.eq(c.maxRounds, 7, "命令行 > 环境变量");
  });
});

test("loadConfig：空字符串环境变量视为未设置", (t) => {
  withEnv({ CLINKAI_MODEL: "" }, () => {
    const c = loadConfig({});
    t.eq(c.model, "qwen3.8-27b-local", "空串应回退默认而不是用空模型名");
  });
});

test("loadConfig：verbose 默认关闭，CLINKAI_VERBOSE=1 开启", (t) => {
  withEnv(clearEnv(), () => {
    t.eq(loadConfig({}).verbose, false);
  });
  withEnv({ CLINKAI_VERBOSE: "1" }, () => {
    t.eq(loadConfig({}).verbose, true);
  });
  withEnv({ CLINKAI_VERBOSE: "0" }, () => {
    t.eq(loadConfig({}).verbose, false);
  });
});

test("loadConfig：CLINKAI_SESSIONS 覆盖会话目录并归一化", (t) => {
  withEnv({ CLINKAI_SESSIONS: "D:\\my\\sessions" }, () => {
    const c = loadConfig({});
    t.eq(c.sessionsDir, "D:\\my\\sessions");
  });
});
