import { SSEChunk } from "./types.ts";

/**
 * 创建 SSE 数据块
 */
export function createSSEChunk(
  id: string, 
  model: string, 
  content: string | null, 
  role: string | null, 
  finish_reason: string | null,
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number }
): string {
  const now = Math.floor(Date.now() / 1000);
  const chunk: SSEChunk = {
    id: id,
    object: "chat.completion.chunk",
    created: now,
    model: model,
    choices: [
      {
        index: 0,
        delta: {},
        finish_reason: finish_reason,
        logprobs: null,
      }
    ],
  };

  if (role) {
    chunk.choices[0].delta.role = role;
  }
  
  if (content) {
    chunk.choices[0].delta.content = content;
  }
  
  if (!role && !content && finish_reason) {
    chunk.choices[0].delta = {};
  }

  if (usage && finish_reason === "stop") {
    (chunk as any).usage = usage;
  }

  return `data: ${JSON.stringify(chunk)}\n\n`;
}

/**
 * 创建错误响应
 */
export function createErrorResponse(
  message: string, 
  status: number, 
  type: string = "invalid_request_error", 
  code: string = "error"
): Response {
  return new Response(
    JSON.stringify({
      error: {
        message,
        type,
        param: null,
        code
      }
    }),
    {
      status,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      }
    }
  );
}

/**
 * 创建授权错误响应
 */
export function createAuthErrorResponse(message: string, code: string): Response {
  return new Response(
    JSON.stringify({
      error: {
        message,
        type: "invalid_request_error",
        param: null,
        code
      }
    }),
    {
      status: 401,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "WWW-Authenticate": 'Bearer realm="API Access"'
      }
    }
  );
}

/**
 * 记录调试信息到控制台
 */
export function logDebug(label: string, data?: any): void {
  if (data !== undefined) {
    console.log(`${label}:`, typeof data === 'object' ? JSON.stringify(data) : data);
  } else {
    console.log(label);
  }
}

/**
 * 记录错误信息到控制台
 */
export function logError(label: string, error: unknown): void {
  console.error(label, error instanceof Error ? error.message : String(error));
}
