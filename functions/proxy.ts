// 文件路径：functions/proxy.ts
// [已合并云同步功能]

// -----------------------------------------------------------------
// [您的旧代码 - 保持不变]
// -----------------------------------------------------------------
const API_BASE_URL = "https://music-api.gdstudio.org/api.php";
const KUWO_HOST_PATTERN = /(^|\.)kuwo\.cn$/i;
const SAFE_RESPONSE_HEADERS = ["content-type", "cache-control", "accept-ranges", "content-length", "content-range", "etag", "last-modified", "expires"];

function createCorsHeaders(init?: Headers): Headers {
  const headers = new Headers();
  if (init) {
    for (const [key, value] of init.entries()) {
      if (SAFE_RESPONSE_HEADERS.includes(key.toLowerCase())) {
        headers.set(key, value);
      }
    }
  }
  if (!headers.has("Cache-Control")) {
    headers.set("Cache-Control", "no-store");
  }
  headers.set("Access-Control-Allow-Origin", "*");
  return headers;
}

function handleOptions(): Response {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,HEAD,POST,OPTIONS", // [修改] 允许 POST
      "Access-Control-Allow-Headers": "*",
      "Access-Control-Max-Age": "86400",
    },
  });
}

function isAllowedKuwoHost(hostname: string): boolean {
  if (!hostname) return false;
  return KUWO_HOST_PATTERN.test(hostname);
}

function normalizeKuwoUrl(rawUrl: string): URL | null {
  try {
    const parsed = new URL(rawUrl);
    if (!isAllowedKuwoHost(parsed.hostname)) {
      return null;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    parsed.protocol = "http:";
    return parsed;
  } catch {
    return null;
  }
}

async function proxyKuwoAudio(targetUrl: string, request: Request): Promise<Response> {
  const normalized = normalizeKuwoUrl(targetUrl);
  if (!normalized) {
    return new Response("Invalid target", { status: 400 });
  }

  const init: RequestInit = {
    method: request.method,
    headers: {
      "User-Agent": request.headers.get("User-Agent") ?? "Mozilla/5.0",
      "Referer": "https://www.kuwo.cn/",
    },
  };

  const rangeHeader = request.headers.get("Range");
  if (rangeHeader) {
    (init.headers as Record<string, string>)["Range"] = rangeHeader;
  }

  const upstream = await fetch(normalized.toString(), init);
  const headers = createCorsHeaders(upstream.headers);
  if (!headers.has("Cache-Control")) {
    headers.set("Cache-Control", "public, max-age=3600");
  }

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  });
}

async function proxyApiRequest(url: URL, request: Request): Promise<Response> {
  const apiUrl = new URL(API_BASE_URL);
  url.searchParams.forEach((value, key) => {
    if (key === "target" || key === "callback") {
      return;
    }
    apiUrl.searchParams.set(key, value);
  });

  if (!apiUrl.searchParams.has("types")) {
    return new Response("Missing types", { status: 400 });
  }

  const upstream = await fetch(apiUrl.toString(), {
    headers: {
      "User-Agent": request.headers.get("User-Agent") ?? "Mozilla/5.0",
      "Accept": "application/json",
    },
  });

  const headers = createCorsHeaders(upstream.headers);
  if (!headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json; charset=utf-8");
  }

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  });
}

// -----------------------------------------------------------------
// [修改后的 onRequest 函数]
// -----------------------------------------------------------------
export async function onRequest(context: any): Promise<Response> { // [修改] 更改签名以接收 context
  const { request, env } = context; // [修改] 从 context 中解构 env
  const url = new URL(request.url);
  const types = url.searchParams.get("types");

  // 1. 处理 OPTIONS (CORS 预检)
  if (request.method === "OPTIONS") {
    return handleOptions();
  }

  // 2. [新增] 处理 POST 请求 (用于保存播放列表)
  if (request.method === "POST") {
    // _middleware.ts 已经验证过密码了，这里是安全的
    if (types === "save_playlist") {
        try {
            const playlistData = await request.text();
            await env.DB.put('main_playlist', playlistData); // 使用 env.DB
            return new Response(JSON.stringify({ success: true }), {
                headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
            });
        } catch (e: any) {
            return new Response(JSON.stringify({ error: e.message }), { status: 500 });
        }
    }
    // 如果是其他 POST 请求，则拒绝
    return new Response("Invalid POST request type", { status: 400 });
  }

  // 3. [修改] 处理 GET 和 HEAD 请求
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method not allowed", { status: 405 });
  }

  // 4. [新增] 处理 GET?types=get_playlist (用于加载播放列表)
  if (types === "get_playlist") {
    try {
        const playlistJson = await env.DB.get('main_playlist'); // 使用 env.DB
        if (!playlistJson) {
            // 云端为空，返回空列表
            return new Response(JSON.stringify([]), { headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
        }
        // 返回云端数据
        return new Response(playlistJson, { headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
    } catch (e: any) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500 });
    }
  }

  // 5. [您的旧逻辑] 处理 Kuwo 音频代理
  const target = url.searchParams.get("target");
  if (target) {
    return proxyKuwoAudio(target, request);
  }

  // 6. [您的旧逻辑] 处理 API 搜索、雷达等
  // (所有其他 types=search, types=lyric 等都会走到这里)
  return proxyApiRequest(url, request);
}
