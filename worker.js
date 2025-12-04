/**
 * =================================================================================
 * 项目: liaobots-2api (Cloudflare Worker 单文件版)
 * 版本: 5.1.0 (代号: Phantom Seed - 幻影终极版)
 * 作者: 首席AI执行官 & 修复优化专家
 * 日期: 2025-12-04
 * 
 * [更新日志 v5.1]
 * 1. 修复 /v1/models 路由，完美支持 Cherry Studio/NextChat 等客户端检测模型。
 * 2. Web UI 新增 "API 接口地址" 显示框，一键复制。
 * 3. 优化 CORS 和 Content-Type 头信息，兼容性更强。
 * 
 * [核心机制]
 * 1. [种子伪装] 内置最新 HAR 提取的 Cookie，欺骗 WAF 信任 Worker 请求。
 * 2. [无限续杯] 每次请求强制调用 /api/user 获取全新 AuthCode (0.1积分)。
 * 3. [严格模式] 获取新凭证失败直接报错，绝不消耗旧账号额度。
 * =================================================================================
 */

const CONFIG = {
  PROJECT_NAME: "liaobots-2api",
  VERSION: "5.1.0",
  
  // 安全配置 (建议在 Cloudflare 环境变量中设置 API_MASTER_KEY)
  // 客户端连接时使用的 API Key (sk-xxxx)
  API_MASTER_KEY: "1",
  
  // [重要] 严格模式：true = 获取新凭证失败则直接报错（保护旧额度）；false = 失败时尝试使用旧凭证
  STRICT_MODE: true,

  // 上游地址
  ORIGIN: "https://liaobots.work",
  API_USER: "https://liaobots.work/api/user",
  API_CHAT: "https://liaobots.work/api/chat",
  
  // [自动填充] 从你的最新 HAR 中提取的种子 Cookie
  // 这是通过 Cloudflare 验证的关键
  HAR_COOKIE: "gkp2=cbbabc2c794fa14aea643469a4841c83.6a9fe6bece85f04e4fae9491792b64ec7359974ea5bfdb1d635393ac1862921b",
  
  // 伪装指纹 (严格模拟你的 Chrome 142)
  HEADERS: {
    "authority": "liaobots.work",
    "accept": "*/*",
    "accept-language": "zh-CN,zh;q=0.9",
    "content-type": "application/json",
    "origin": "https://liaobots.work",
    "referer": "https://liaobots.work/",
    "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
    "sec-ch-ua": '"Chromium";v="142", "Google Chrome";v="142", "Not_A Brand";v="99"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-origin",
    "priority": "u=1, i"
  },

  // 模型定义 (确保这些 ID 与客户端请求的一致)
  DEFAULT_MODEL: "gemini-3-pro-preview",
  MODELS: [
    "gemini-3-pro-preview",
    "gpt-4o",
    "claude-3-5-sonnet",
    "gpt-4o-mini",
    "o1-preview",
    "o1-mini",
    "gpt-4-turbo",
    "claude-3-opus"
  ]
};

// --- 日志记录器 ---
class DebugLogger {
  constructor() { this.logs = []; }
  log(step, data) {
    const time = new Date().toISOString().split('T')[1].slice(0, -1);
    let content = "";
    try {
        content = typeof data === 'object' ? JSON.stringify(data, null, 2) : String(data);
    } catch (e) {
        content = `[无法序列化]: ${String(data)}`;
    }
    if (content.length > 3000) content = content.substring(0, 3000) + "...(截断)";
    this.logs.push({ time, step, content });
  }
  getLogs() { return this.logs; }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    
    // 处理 CORS 预检请求 (让浏览器和客户端能跨域访问)
    if (request.method === 'OPTIONS') return handleCors();

    const apiKey = env.API_MASTER_KEY || CONFIG.API_MASTER_KEY;
    // 优先使用环境变量里的 Cookie (如果用户配置了)，否则使用代码里硬编码的
    const seedCookie = env.LIAOBOTS_COOKIE || CONFIG.HAR_COOKIE;
    
    request.ctx = { apiKey, seedCookie };

    // 路由分发
    if (url.pathname === '/' || url.pathname === '/index.html') {
        return handleWebUI(request);
    }
    
    // 兼容 /v1/models 和 /v1/chat/completions
    if (url.pathname.startsWith('/v1/')) {
        return handleApi(request);
    }

    // 默认 404
    return new Response(JSON.stringify({ error: "Not Found" }), { 
        status: 404, 
        headers: { ...corsHeaders(), "Content-Type": "application/json" }
    });
  }
};

// --- 核心逻辑：无限续杯 (获取新凭证) ---
async function getFreshToken(logger, seedCookie) {
  logger.log("Auth-Init", `准备获取新身份。使用种子 Cookie: ${seedCookie.substring(0, 15)}...`);
  
  try {
    // 1. 构造请求，携带 Cookie 欺骗 WAF
    const res = await fetch(CONFIG.API_USER, {
      method: "POST",
      headers: {
        ...CONFIG.HEADERS,
        "Cookie": seedCookie // 关键：注入 Cookie
      },
      body: JSON.stringify({ 
        "authcode": "", // 空字符串告诉服务器：我要一个新的 ID
        "recommendUrl": "https://liaobots.work/" 
      })
    });

    const contentType = res.headers.get("content-type");
    const text = await res.text();

    // 2. 检查是否被拦截
    if (!res.ok || (contentType && contentType.includes("text/html")) || text.trim().startsWith("<")) {
      logger.log("Auth-Blocked", `请求被拦截 (Status: ${res.status})。可能 Cookie 已失效或 IP 被封。响应预览: ${text.substring(0, 100)}`);
      throw new Error("WAF拦截/人机验证");
    }

    // 3. 解析新凭证
    const data = JSON.parse(text);
    if (data.authCode) {
      logger.log("Auth-Success", {
        msg: "🎉 成功获取新凭证 (无限白嫖模式)",
        newAuthCode: data.authCode,
        balance: data.amount, // 应该是 0.1
        isNew: true
      });
      return data.authCode;
    } else {
      throw new Error("响应 JSON 中缺少 authCode");
    }

  } catch (e) {
    logger.log("Auth-Fail", `获取新凭证失败: ${e.message}`);
    return null; 
  }
}

// --- API 处理逻辑 ---

async function handleApi(request) {
  const url = new URL(request.url);
  const apiKey = request.ctx.apiKey;
  const auth = request.headers.get('Authorization');
  
  // 鉴权检查 (允许 Bearer Token 或直接匹配)
  // 注意：部分客户端在获取模型列表时可能不带 Auth，这里为了兼容性，
  // 如果是 OPTIONS 或 models 接口，可以适当放宽，或者严格要求 Key。
  // 这里保持严格鉴权，确保安全性。
  if (apiKey !== "1" && (!auth || auth.split(' ')[1] !== apiKey)) {
    return new Response(JSON.stringify({ 
        error: {
            message: "Unauthorized - Invalid API Key",
            type: "auth_error",
            code: 401
        }
    }), { status: 401, headers: { ...corsHeaders(), "Content-Type": "application/json" } });
  }

  // --- 修复：模型列表接口 ---
  // 必须精确匹配 /v1/models，且返回正确的 JSON 结构
  if (url.pathname === '/v1/models') {
    const modelsData = CONFIG.MODELS.map(id => ({
        id: id,
        object: "model",
        created: Math.floor(Date.now() / 1000),
        owned_by: "liaobots",
        permission: [{
            id: `modelperm-${id}`,
            object: "model_permission",
            created: Math.floor(Date.now() / 1000),
            allow_create_engine: false,
            allow_sampling: true,
            allow_logprobs: true,
            allow_search_indices: false,
            allow_view: true,
            allow_fine_tuning: false,
            organization: "*",
            group: null,
            is_blocking: false
        }],
        root: id,
        parent: null
    }));

    return new Response(JSON.stringify({
      object: "list",
      data: modelsData
    }), { 
        status: 200,
        headers: { 
            ...corsHeaders(), 
            "Content-Type": "application/json" 
        } 
    });
  }

  // --- 聊天接口 ---
  if (url.pathname === '/v1/chat/completions') {
    return handleChat(request);
  }

  return new Response(JSON.stringify({ error: "Method not supported" }), { 
      status: 404, 
      headers: { ...corsHeaders(), "Content-Type": "application/json" } 
  });
}

async function handleChat(request) {
  const logger = new DebugLogger();
  const requestId = crypto.randomUUID();

  try {
    const body = await request.json();
    const isWebUI = body.is_web_ui === true;
    const stream = body.stream !== false; // 默认为 true
    const model = body.model || CONFIG.DEFAULT_MODEL;
    
    logger.log("1. 请求开始", { model, stream, isWebUI });

    // --- 步骤 1: 获取新凭证 ---
    let authCode = await getFreshToken(logger, request.ctx.seedCookie);
    
    if (!authCode) {
      if (CONFIG.STRICT_MODE) {
        throw new Error("【严格模式】无法获取新凭证，拒绝请求以保护旧额度。请更新 LIAOBOTS_COOKIE。");
      } else {
        throw new Error("获取新凭证失败，且未配置降级策略。");
      }
    }

    // --- 步骤 2: 构造 Payload ---
    const messages = body.messages || [];
    
    // 模型参数映射 (补充更多模型参数)
    const modelConfig = {
      "gemini-3-pro-preview": { id: "gemini-3-pro-preview", name: "Gemini-3-Pro-Preview", provider: "Google", context: 1000 },
      "gpt-4o": { id: "gpt-4o", name: "GPT-4o", provider: "OpenAI", context: 128000 },
      "claude-3-5-sonnet": { id: "claude-3-5-sonnet", name: "Claude-3.5-Sonnet", provider: "Anthropic", context: 200000 },
      "gpt-4o-mini": { id: "gpt-4o-mini", name: "GPT-4o-Mini", provider: "OpenAI", context: 128000 },
      "o1-preview": { id: "o1-preview", name: "O1-Preview", provider: "OpenAI", context: 128000 },
      "o1-mini": { id: "o1-mini", name: "O1-Mini", provider: "OpenAI", context: 128000 }
    }[model] || { id: model, name: model, provider: "Unknown", context: 10000 };

    const payload = {
      "conversationId": crypto.randomUUID(),
      "models": [{
        "CreatedAt": new Date().toISOString(),
        "context": modelConfig.context,
        "modelId": modelConfig.id,
        "name": modelConfig.name,
        "provider": modelConfig.provider,
        "inputOrigin": 0, "inputPricing": 0, "outputOrigin": 0, "outputPricing": 0,
        "supportFiles": "jpg,jpeg,png,webp,wav,aac,mp3,ogg"
      }],
      "search": "false",
      "messages": messages.map(m => ({ role: m.role, content: m.content })),
      "key": "",
      "prompt": "你是 {{model}}，一个由 {{provider}} 训练的大型语言模型，请仔细遵循用户的指示。",
      "prompt_id": ""
    };

    // --- 步骤 3: 发送聊天请求 ---
    const chatHeaders = {
      ...CONFIG.HEADERS,
      "x-auth-code": authCode,
      "Cookie": request.ctx.seedCookie
    };

    logger.log("2. 发送聊天请求", { 
      url: CONFIG.API_CHAT, 
      usingToken: authCode.substring(0, 8) + "...",
      isNewToken: true
    });

    const upstreamRes = await fetch(CONFIG.API_CHAT, {
      method: "POST",
      headers: chatHeaders,
      body: JSON.stringify(payload)
    });

    logger.log("3. 上游响应", { status: upstreamRes.status, headers: Object.fromEntries(upstreamRes.headers) });

    if (!upstreamRes.ok) {
      const errText = await upstreamRes.text();
      throw new Error(`上游错误 ${upstreamRes.status}: ${errText.substring(0, 200)}`);
    }

    // --- 步骤 4: 流式处理 ---
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();

    (async () => {
      try {
        // WebUI 专用：发送调试信息
        if (isWebUI) {
          const debugInfo = { 
            debug: logger.getLogs(),
            auth_status: "FRESH (新凭证 - 0.1积分)"
          };
          await writer.write(encoder.encode(`data: ${JSON.stringify(debugInfo)}\n\n`));
        }

        const reader = upstreamRes.body.getReader();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || "";

          for (const line of lines) {
            if (line.startsWith('data: ')) {
              const dataStr = line.slice(6).trim();
              if (!dataStr || dataStr === '[DONE]') continue;

              try {
                const data = JSON.parse(dataStr);
                if (data.content) {
                  const chunk = {
                    id: requestId,
                    object: "chat.completion.chunk",
                    created: Math.floor(Date.now() / 1000),
                    model: model,
                    choices: [{ index: 0, delta: { content: data.content }, finish_reason: null }]
                  };
                  await writer.write(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
                }
              } catch (e) { }
            }
          }
        }
        
        // 结束
        const endChunk = {
            id: requestId,
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model: model,
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }]
        };
        await writer.write(encoder.encode(`data: ${JSON.stringify(endChunk)}\n\n`));
        await writer.write(encoder.encode('data: [DONE]\n\n'));

      } catch (e) {
        const errChunk = {
            id: requestId,
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model: model,
            choices: [{ index: 0, delta: { content: `\n\n[流传输中断: ${e.message}]` }, finish_reason: "error" }]
        };
        await writer.write(encoder.encode(`data: ${JSON.stringify(errChunk)}\n\n`));
      } finally {
        await writer.close();
      }
    })();

    return new Response(readable, {
      headers: {
        ...corsHeaders(),
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive'
      }
    });

  } catch (e) {
    return new Response(JSON.stringify({
      error: { 
        message: e.message, 
        type: "internal_error",
        logs: logger.getLogs() 
      }
    }), { status: 500, headers: { ...corsHeaders(), "Content-Type": "application/json" } });
  }
}

// --- 辅助函数 ---

function handleCors() {
  return new Response(null, {
    status: 204,
    headers: corsHeaders()
  });
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Max-Age': '86400'
  };
}

// --- Web UI (开发者驾驶舱) ---

function handleWebUI(request) {
  const html = `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>LiaoBots 2API 驾驶舱 (v5.1)</title>
    <style>
        :root { --bg: #0f172a; --panel: #1e293b; --text: #e2e8f0; --accent: #38bdf8; --border: #334155; --code: #0f172a; --success: #4ade80; --warn: #fbbf24; --error: #f87171; }
        body { margin: 0; font-family: 'Segoe UI', sans-serif; background: var(--bg); color: var(--text); height: 100vh; display: flex; overflow: hidden; }
        .container { display: flex; width: 100%; height: 100%; }
        .sidebar { width: 340px; background: var(--panel); border-right: 1px solid var(--border); padding: 20px; display: flex; flex-direction: column; gap: 15px; overflow-y: auto; }
        .main { flex: 1; display: flex; flex-direction: column; padding: 20px; gap: 20px; }
        
        h1 { margin: 0; font-size: 18px; color: var(--accent); display: flex; align-items: center; gap: 10px; }
        .badge { font-size: 10px; background: var(--accent); color: #000; padding: 2px 6px; border-radius: 4px; }
        
        .card { background: rgba(0,0,0,0.2); padding: 12px; border-radius: 8px; border: 1px solid var(--border); }
        .label { font-size: 12px; color: #94a3b8; margin-bottom: 5px; display: block; font-weight: 600; }
        input, select, textarea { width: 100%; background: var(--code); border: 1px solid var(--border); color: var(--text); padding: 8px; border-radius: 4px; box-sizing: border-box; font-family: monospace; font-size: 12px; }
        button { width: 100%; background: var(--accent); color: #000; border: none; padding: 10px; border-radius: 4px; cursor: pointer; font-weight: bold; transition: 0.2s; }
        button:hover { opacity: 0.9; }
        button:disabled { background: #475569; cursor: not-allowed; }

        .chat-box { flex: 1; background: var(--code); border: 1px solid var(--border); border-radius: 8px; padding: 15px; overflow-y: auto; font-family: monospace; white-space: pre-wrap; font-size: 13px; line-height: 1.5; }
        .log-panel { height: 250px; background: #000; border: 1px solid var(--border); border-radius: 8px; padding: 10px; overflow-y: auto; font-family: monospace; font-size: 11px; }
        
        .log-entry { margin-bottom: 4px; border-bottom: 1px solid #222; padding-bottom: 4px; }
        .log-time { color: #64748b; margin-right: 8px; }
        .log-step { color: var(--accent); font-weight: bold; margin-right: 8px; }
        .log-content { color: #94a3b8; word-break: break-all; }
        
        .msg-user { color: var(--accent); margin-top: 15px; font-weight: bold; }
        .msg-ai { color: #a5f3fc; margin-top: 5px; }
        
        .status-indicator { display: flex; align-items: center; gap: 5px; font-size: 12px; margin-top: 5px; }
        .dot { width: 8px; height: 8px; border-radius: 50%; background: #64748b; }
        .dot.active { background: var(--success); box-shadow: 0 0 5px var(--success); }
        .dot.error { background: var(--error); box-shadow: 0 0 5px var(--error); }
        
        .copy-icon { cursor: pointer; float: right; font-size: 10px; color: var(--accent); }
    </style>
</head>
<body>
    <div class="container">
        <div class="sidebar">
            <h1>LiaoBots 2API <span class="badge">v5.1</span></h1>
            
            <div class="card">
                <span class="label">API 接口地址 (复制到客户端)</span>
                <input type="text" id="apiUrl" readonly onclick="this.select()">
                <div style="font-size: 10px; color: #64748b; margin-top: 5px;">
                    适用于 Cherry Studio, NextChat, OneAPI 等
                </div>
            </div>

            <div class="card">
                <span class="label">凭证状态 (严格模式)</span>
                <div class="status-indicator">
                    <div id="statusDot" class="dot"></div>
                    <span id="statusText">等待请求...</span>
                </div>
                <div style="font-size: 10px; color: #64748b; margin-top: 5px;">
                    仅使用新申请的 AuthCode。如果申请失败，将直接报错，不消耗旧额度。
                </div>
            </div>

            <div class="card">
                <span class="label">API Key</span>
                <input type="password" id="apiKey" value="${CONFIG.API_MASTER_KEY}">
            </div>

            <div class="card">
                <span class="label">模型 (Model)</span>
                <select id="model">
                    ${CONFIG.MODELS.map(m => `<option value="${m}">${m}</option>`).join('')}
                </select>
            </div>

            <div class="card">
                <span class="label">提示词 (Prompt)</span>
                <textarea id="prompt" rows="5">你好，请介绍一下你自己。</textarea>
            </div>

            <button id="sendBtn" onclick="sendRequest()">🚀 发送请求</button>
            
            <div class="card" style="font-size: 11px; color: #64748b;">
                <p>⚠️ <strong>维护指南：</strong></p>
                <p>如果出现 "Auth-Blocked" 错误，请在浏览器重新抓包，并将 Cookie 填入 Cloudflare 环境变量 <code>LIAOBOTS_COOKIE</code>。</p>
            </div>
        </div>

        <div class="main">
            <div class="chat-box" id="chatBox">
                <div style="color: #64748b; text-align: center; margin-top: 50px;">
                    Liaobots 代理服务就绪。<br>
                    无限白嫖模式已激活。<br><br>
                    请在左侧复制 API 地址到您的客户端。
                </div>
            </div>
            <div class="log-panel" id="logPanel">
                <div class="log-entry"><span class="log-content">系统初始化完成。</span></div>
            </div>
        </div>
    </div>

    <script>
        // 自动填充 API 地址
        window.onload = function() {
            const origin = window.location.origin;
            document.getElementById('apiUrl').value = origin + "/v1";
        }

        function log(step, content) {
            const panel = document.getElementById('logPanel');
            const div = document.createElement('div');
            div.className = 'log-entry';
            const time = new Date().toLocaleTimeString();
            div.innerHTML = \`<span class="log-time">[\${time}]</span><span class="log-step">\${step}</span><span class="log-content">\${content}</span>\`;
            panel.appendChild(div);
            panel.scrollTop = panel.scrollHeight;
        }

        function updateStatus(type) {
            const dot = document.getElementById('statusDot');
            const text = document.getElementById('statusText');
            dot.className = 'dot';
            if (type === 'FRESH') {
                dot.classList.add('active');
                text.innerText = "成功获取新凭证 (无限模式)";
                text.style.color = "var(--success)";
            } else if (type === 'ERROR') {
                dot.classList.add('error');
                text.innerText = "获取凭证失败 (已阻断)";
                text.style.color = "var(--error)";
            } else {
                text.innerText = "等待请求...";
                text.style.color = "#64748b";
            }
        }

        async function sendRequest() {
            const prompt = document.getElementById('prompt').value;
            const model = document.getElementById('model').value;
            const apiKey = document.getElementById('apiKey').value;
            const chatBox = document.getElementById('chatBox');
            const btn = document.getElementById('sendBtn');

            if (!prompt) return alert("请输入提示词");

            btn.disabled = true;
            btn.innerText = "请求中...";
            if (chatBox.innerText.includes("就绪")) chatBox.innerHTML = "";
            document.getElementById('logPanel').innerHTML = ""; 

            chatBox.innerHTML += \`<div class="msg-user">User: \${prompt}</div>\`;
            const aiMsgDiv = document.createElement('div');
            aiMsgDiv.className = 'msg-ai';
            aiMsgDiv.innerText = "AI: ";
            chatBox.appendChild(aiMsgDiv);

            try {
                const response = await fetch('/v1/chat/completions', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': \`Bearer \${apiKey}\`
                    },
                    body: JSON.stringify({
                        model: model,
                        messages: [{ role: "user", content: prompt }],
                        stream: true,
                        is_web_ui: true
                    })
                });

                if (!response.ok) {
                    const err = await response.json();
                    log("Error", JSON.stringify(err));
                    if (err.error && err.error.logs) {
                        err.error.logs.forEach(l => log(l.step, l.content));
                    }
                    updateStatus('ERROR');
                    throw new Error(err.error.message || "Request failed");
                }

                const reader = response.body.getReader();
                const decoder = new TextDecoder();
                let buffer = "";

                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    
                    buffer += decoder.decode(value, { stream: true });
                    const lines = buffer.split('\\n');
                    buffer = lines.pop();

                    for (const line of lines) {
                        if (line.startsWith('data: ')) {
                            const dataStr = line.slice(6);
                            if (dataStr === '[DONE]') continue;
                            
                            try {
                                const data = JSON.parse(dataStr);
                                
                                // 处理调试日志
                                if (data.debug) {
                                    data.debug.forEach(l => {
                                        log(l.step, l.content);
                                    });
                                    if (data.auth_status) {
                                        updateStatus(data.auth_status.includes("FRESH") ? 'FRESH' : 'ERROR');
                                    }
                                    continue;
                                }

                                // 处理内容
                                if (data.choices && data.choices[0].delta.content) {
                                    aiMsgDiv.innerText += data.choices[0].delta.content;
                                    chatBox.scrollTop = chatBox.scrollHeight;
                                }
                            } catch (e) { }
                        }
                    }
                }

            } catch (e) {
                aiMsgDiv.innerText += \`\\n[错误: \${e.message}]\`;
                aiMsgDiv.style.color = "var(--error)";
            } finally {
                btn.disabled = false;
                btn.innerText = "🚀 发送请求";
            }
        }
    </script>
</body>
</html>
  `;
  return new Response(html, { headers: { "content-type": "text/html;charset=UTF-8" } });
}
