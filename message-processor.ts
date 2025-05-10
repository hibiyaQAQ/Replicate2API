import { Message, ContentItem, ModelInput } from "./types.ts";
import { logDebug, logError } from "./utils.ts";

/**
 * 处理消息并提取系统提示、图片URL和格式化对话内容
 */
export function processMessages(requestBody: { messages: Message[] }): {
  userContent: string | undefined;
  systemPrompt: string;
  imageUrls: string[];
} {
  let userContent: string | undefined;
  const imageUrls: string[] = [];
  let systemPrompt = "";

  if (!Array.isArray(requestBody.messages) || requestBody.messages.length === 0) {
    return { userContent: undefined, systemPrompt, imageUrls };
  }

  try {
    // 深拷贝，安全改动
    const messagesClone = JSON.parse(JSON.stringify(requestBody.messages)) as Message[];

    // 提取 system prompt
    systemPrompt = extractSystemPrompt(messagesClone);

    // 提取图片 URL
    extractImageUrls(messagesClone, imageUrls);

    // 格式化剩余消息
    userContent = formatMessagesToConversation(messagesClone);

    logDebug("Extracted image URLs:", imageUrls.length > 0 ? `Found ${imageUrls.length}` : "No images");
    return { userContent, systemPrompt, imageUrls };
  } catch (e) {
    logError("Failed to process 'messages':", e);
    return { userContent: undefined, systemPrompt, imageUrls };
  }
}

/** 从系统消息中抽取提示 */
function extractSystemPrompt(messages: Message[]): string {
  let systemPrompt = "";
  const systemMessages = messages.filter(msg => msg.role === "system");

  for (const sysMsg of systemMessages) {
    if (typeof sysMsg.content === "string") {
      systemPrompt += sysMsg.content + "\n";
    } else if (Array.isArray(sysMsg.content)) {
      for (const item of sysMsg.content as ContentItem[]) {
        if (item.type === "text" && item.text) {
          systemPrompt += item.text + "\n";
        }
      }
    }
  }

  // 移除这些系统消息
  const nonSys = messages.filter(msg => msg.role !== "system");
  messages.length = 0;
  messages.push(...nonSys);

  return systemPrompt.trim();
}

/** 提取用户内容里的 image_url，并留下纯文本内容 */
function extractImageUrls(messages: Message[], imageUrls: string[]): void {
  for (const message of messages) {
    if (message.role === "user" && Array.isArray(message.content)) {
      const textOnly: ContentItem[] = [];
      for (const item of message.content) {
        if (item.type === "image_url" && item.image_url?.url) {
          imageUrls.push(item.image_url.url);
        } else if (item.type === "text") {
          textOnly.push(item);
        }
      }
      message.content = textOnly;
    }
  }
}

/** 把剩下的消息按 “role: content” 拼成一个长字符串 */
function formatMessagesToConversation(messages: Message[]): string {
  let formatted = "";
  for (const msg of messages) {
    if (msg.role && (typeof msg.content === "string" || Array.isArray(msg.content))) {
      formatted += `${msg.role}: `;
      if (Array.isArray(msg.content)) {
        formatted += (msg.content as ContentItem[])
          .filter(i => i.type === "text")
          .map(i => i.text).join(" ");
      } else {
        formatted += msg.content;
      }
      formatted += "\n";
    }
  }
  logDebug("Formatted user content:", formatted);
  return formatted;
}

/**
 * 用上面提取的 userContent、systemPrompt、imageUrls 构造 ModelInput
 */
export function buildModelInput(
  userContent: string,
  systemPrompt: string,
  imageUrls: string[]
): ModelInput {
  const input: ModelInput = {
    prompt: userContent,
    max_tokens: 64000,
    system_prompt: systemPrompt,
    max_image_resolution: 0.5,
  };

  if (imageUrls.length > 0) {
    input.image = imageUrls.length === 1
      ? imageUrls[0]
      : imageUrls[imageUrls.length - 1];
    logDebug("Added image to input");
  }

  return input;
}
