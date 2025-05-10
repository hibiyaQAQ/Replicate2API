import {
  createSSEChunk,
  createErrorResponse,
  createAuthErrorResponse,
  logDebug,
  logError
} from "./utils.ts";
import {
  API_PATHS,
  AUTH_KEY,
  CORS_HEADERS,
  ERROR_CODES,
  MODELS,
  PROXY_MODEL_NAME
} from "./config.ts";
import { processMessages, buildModelInput } from "./message-processor.ts";
import { defaultApiService } from "./api-service.ts";
import { RequestBody, ChatCompletion, ModelInput } from "./types.ts";
// controllers.ts（或任何用到 encode 的地方）
import { encode } from "https://cdn.jsdelivr.net/npm/gpt-tokenizer@2.9.0/esm/encoding/o200k_base.js";

/** 处理CORS预检请求 */
export function handleCorsPreflightRequest(): Response {
    return new Response(null, {
        status: 204,
        headers: CORS_HEADERS,
    });
}

/** 获取模型列表 */
export function handleModelsRequest(): Response {
    return new Response(
        JSON.stringify({
            object: "list",
            data: MODELS,
        }),
        {
            status: 200,
            headers: {
                "Content-Type": "application/json",
                ...CORS_HEADERS,
            },
        }
    );
}

/** 404处理 */
export function handleNotFoundRequest(): Response {
    return createErrorResponse(
        "Not Found or Method Not Allowed",
        404,
        "invalid_request_error",
        ERROR_CODES.INVALID_JSON
    );
}

/** 验证客户端 Authorization Bearer */
export function validateApiKey(authHeader: string | null): {
    isValid: boolean;
    providedKey?: string;
    response?: Response;
} {
    if (!authHeader || !authHeader.toLowerCase().startsWith("bearer ")) {
        logDebug("认证失败: 缺少或格式错误的 Authorization header");
        return {
            isValid: false,
            response: createAuthErrorResponse(
                "Unauthorized: Missing or invalid Authorization header. Use 'Bearer <YOUR_API_KEY>' format.",
                ERROR_CODES.MISSING_AUTH_HEADER
            )
        };
    }
    const providedKey = authHeader.substring(7);
    logDebug("providedKey：" + providedKey);

    if (providedKey !== AUTH_KEY) {
        logDebug("认证失败: 无效的 API Key 提供");
        return {
            isValid: false,
            response: createAuthErrorResponse(
                "Unauthorized: Invalid API Key provided.",
                ERROR_CODES.INVALID_AUTH_KEY
            )
        };
    }
    return { isValid: true, providedKey };
}

/** 聊天完成总入口 */
export async function handleChatCompletionRequest(req: Request): Promise<Response> {
    const authValidation = validateApiKey(req.headers.get("Authorization"));
    if (!authValidation.isValid) {
        return authValidation.response!;
    }

    try {
        let requestBody: RequestBody;
        try {
            requestBody = await req.json() as RequestBody;
            logDebug("requestBody", requestBody);
        } catch (e) {
            logError("Failed to parse request JSON:", e);
            return createErrorResponse(
                "Invalid JSON in request body",
                400,
                "invalid_request_error",
                ERROR_CODES.INVALID_JSON
            );
        }

        const isStream = requestBody.stream === true;
        const { userContent, systemPrompt, imageUrls } = processMessages(requestBody);

        if (!userContent) {
            return createErrorResponse(
                "Request body must contain a non-empty 'messages' array.",
                400,
                "invalid_request_error",
                ERROR_CODES.INVALID_MESSAGES
            );
        }

        const input: ModelInput = buildModelInput(userContent, systemPrompt, imageUrls);
        const chatCompletionId = `chatcmpl-${crypto.randomUUID()}`;
        const modelName = requestBody.model || PROXY_MODEL_NAME;

        if (isStream) {
            return handleStreamResponse(chatCompletionId, modelName, input);
        } else {
            return handleNonStreamResponse(chatCompletionId, modelName, input);
        }
    } catch (error) {
        logError("Unhandled error in handler:", error);
        return createErrorResponse(
            "Internal Server Error",
            500,
            "internal_error",
            ERROR_CODES.INTERNAL_ERROR
        );
    }
}

/** 流式响应处理 */
function handleStreamResponse(
    chatCompletionId: string,
    modelName: string,
    input: ModelInput
): Response {
    logDebug("Processing stream response...");

    const promptTokens = encode(input.prompt).length;
    const systemPromptTokens = input.system_prompt ? encode(input.system_prompt).length : 0;
    const totalPromptTokens = promptTokens + systemPromptTokens;

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
        async start(controller) {
            try {
                let isFirstEvent = true;
                let completionContent = "";

                for await (const event of defaultApiService.streamModelResponse(input)) {
                    if (isFirstEvent) {
                        controller.enqueue(encoder.encode(
                            createSSEChunk(chatCompletionId, modelName, null, "assistant", null)
                        ));
                        isFirstEvent = false;
                    }

                    if (event.event === "output" && typeof event.data === "string") {
                        completionContent += event.data;
                        controller.enqueue(encoder.encode(
                            createSSEChunk(chatCompletionId, modelName, event.data, null, null)
                        ));
                        await new Promise(resolve => setTimeout(resolve, 5));
                    } else if (event.event === "done") {
                        const completionTokens = encode(completionContent).length;
                        const totalTokens = totalPromptTokens + completionTokens;
                        const usageInfo = {
                            prompt_tokens: totalPromptTokens,
                            completion_tokens: completionTokens,
                            total_tokens: totalTokens
                        };
                        controller.enqueue(encoder.encode(
                            createSSEChunk(chatCompletionId, modelName, null, null, "stop", usageInfo)
                        ));
                        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                        logDebug("Stream response completed. Final content length: " + completionContent.length);
                        logDebug("Usage info: " + JSON.stringify(usageInfo));
                    }
                }

                controller.close();
            } catch (error) {
                logError("Error during stream processing:", error);
                controller.error(error);
            }
        }
    });

    return new Response(stream, {
        status: 200,
        headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            ...CORS_HEADERS
        },
    });
}

/** 非流式响应处理 */
async function handleNonStreamResponse(
    chatCompletionId: string,
    modelName: string,
    input: ModelInput
): Promise<Response> {
    logDebug("Processing non-stream response.");

    try {
        const assistantContent = await defaultApiService.getModelResponse(input);

        const promptTokens = encode(input.prompt).length;
        const systemPromptTokens = input.system_prompt ? encode(input.system_prompt).length : 0;
        const completionTokens = encode(assistantContent).length;
        const totalTokens = promptTokens + systemPromptTokens + completionTokens;

        const finalResponse: ChatCompletion = {
            id: chatCompletionId,
            object: "chat.completion",
            created: Math.floor(Date.now() / 1000),
            model: modelName,
            choices: [
                {
                    index: 0,
                    message: {
                        role: "assistant",
                        content: assistantContent,
                    },
                    finish_reason: "stop",
                    logprobs: null,
                }
            ],
            usage: {
                prompt_tokens: promptTokens + systemPromptTokens,
                completion_tokens: completionTokens,
                total_tokens: totalTokens
            },
        };

        logDebug("No stream response:", finalResponse);

        return new Response(JSON.stringify(finalResponse), {
            status: 200,
            headers: {
                'Content-Type': 'application/json',
                ...CORS_HEADERS
            },
        });
    } catch (error) {
        logError("Error calling API:", error);
        const errorMessage = error instanceof Error ? error.message : String(error);
        return createErrorResponse(
            `Failed to get response from API: ${errorMessage}`,
            500,
            "api_error",
            ERROR_CODES.API_ERROR
        );
    }
}

/** 路由请求到相应的处理函数 */
export async function routeRequest(req: Request): Promise<Response> {
    const url = new URL(req.url);

    if (req.method === "OPTIONS") {
        return handleCorsPreflightRequest();
    }

    if (url.pathname === API_PATHS.MODELS && req.method === "GET") {
        return handleModelsRequest();
    }

    if (url.pathname === API_PATHS.CHAT_COMPLETIONS && req.method === "POST") {
        return await handleChatCompletionRequest(req);
    }

    return handleNotFoundRequest();
}
