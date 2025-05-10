import {
  replicate,
  DEFAULT_MODEL_ID,
  getNextReplicateClient,
  REPLICATE_API_KEYS
} from "./config.ts";
import { ModelInput, ReplicateEvent } from "./types.ts";
import { logDebug, logError } from "./utils.ts";

/**
 * Replicate模型ID类型，格式为 `owner/model` 或 `owner/model:version`
 */
type ReplicateModelId = `${string}/${string}` | `${string}/${string}:${string}`;

/**
 * API服务类，封装与Replicate API的交互
 */
export class ApiService {
    private modelId: ReplicateModelId;
    private maxRetries: number;

    constructor(modelId: ReplicateModelId = DEFAULT_MODEL_ID as ReplicateModelId) {
        this.modelId = modelId;
        this.maxRetries = Math.min(REPLICATE_API_KEYS.length, 3);
    }

    private getReplicateClient(): typeof replicate {
        return getNextReplicateClient();
    }

    async *streamModelResponse(input: ModelInput): AsyncIterable<ReplicateEvent> {
        let retries = 0;
        let lastError: Error | undefined;

        let replicateClient = this.getReplicateClient();

        while (retries <= this.maxRetries) {
            try {
                logDebug(`尝试流式API调用 (尝试 ${retries + 1}/${this.maxRetries + 1})，模型: ${this.modelId}`);
                logDebug("输入:", input);

                for await (const event of replicateClient.stream(this.modelId, { input })) {
                    yield event;
                }
                return;
            } catch (error) {
                lastError = error instanceof Error ? error : new Error(String(error));
                logError(`流式API调用失败 (尝试 ${retries + 1}/${this.maxRetries + 1}):`, error);

                if (retries < this.maxRetries) {
                    replicateClient = this.getReplicateClient();
                    logDebug("切换到下一个API密钥并重试");
                    retries++;
                } else break;
            }
        }

        throw lastError || new Error("所有API密钥调用都失败");
    }

    async getModelResponse(input: ModelInput): Promise<string> {
        let retries = 0;
        let lastError: Error | undefined;

        let replicateClient = this.getReplicateClient();

        while (retries <= this.maxRetries) {
            try {
                logDebug(`尝试非流式API调用 (尝试 ${retries + 1}/${this.maxRetries + 1})，模型: ${this.modelId}`);
                logDebug("输入:", input);

                const prediction = await replicateClient.run(this.modelId, { input });
                logDebug("API响应:", prediction);

                if (Array.isArray(prediction)) {
                    return prediction.join("");
                } else {
                    return String(prediction);
                }
            } catch (error) {
                lastError = error instanceof Error ? error : new Error(String(error));
                logError(`非流式API调用失败 (尝试 ${retries + 1}/${this.maxRetries + 1}):`, error);

                if (retries < this.maxRetries) {
                    replicateClient = this.getReplicateClient();
                    logDebug("切换到下一个API密钥并重试");
                    retries++;
                } else break;
            }
        }

        throw lastError || new Error("所有API密钥调用都失败");
    }

    setModelId(modelId: ReplicateModelId): void {
        this.modelId = modelId;
    }

    getModelId(): ReplicateModelId {
        return this.modelId;
    }
}

export function createApiService(modelId?: ReplicateModelId): ApiService {
    return new ApiService(modelId);
}

export const defaultApiService = createApiService();
