// Public configuration. The API key deliberately does NOT live here: it is
// entered in the workspace settings and cached in this browser's localStorage,
// so the published userscript never ships a secret.
export const AI_CONFIG = Object.freeze({
  endpoint: 'https://api.siliconflow.cn/v1/chat/completions',
  model: 'deepseek-ai/DeepSeek-V4-Pro',
  // SiliconFlow runs hybrid reasoning models with thinking on by default; that is the
  // dominant latency cost. A measured probe: 9.5s with thinking vs 1.7s with it off.
  disableThinking: true
});
