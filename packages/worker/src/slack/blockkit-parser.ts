#!/usr/bin/env bun

import { MarkedExtension, Marked } from "marked";
import logger from "../logger";

interface BlockMetadata {
  action?: string;        // Button label for the action
  action_id?: string;     // Legacy support for action_id
  confirm?: boolean;      // Show confirmation dialog
  show?: boolean;         // Show the code content to user
  type?: string;          // Type of code block (blockkit, bash, python, etc.)
}

interface ParsedBlock {
  metadata: BlockMetadata;
  content: string;        // Raw content of the code block
  blocks?: any[];         // Parsed blocks if type is blockkit
  language: string;       // Language of the code block
}

interface SlackMessage {
  text: string;
  blocks?: any[];
}

/**
 * Parse metadata from code block info string
 * Supports formats like:
 * - "blockkit { action: 'Run Tests', confirm: true }"
 * - "bash { action: 'Deploy', show: true }"
 * - "python { action: 'Analyze Data' }"
 */
function parseBlockMetadata(info: string): { language: string; metadata: BlockMetadata } {
  if (!info) {
    return { language: '', metadata: {} };
  }

  // Handle case where info is like "blockkit {" (opening brace only)
  const trimmed = info.trim();
  if (trimmed.endsWith('{')) {
    return { 
      language: trimmed.slice(0, -1).trim(), 
      metadata: { show: true } // Default to showing blockkit content
    };
  }

  // Extract language and metadata parts
  const match = info.match(/^(\w+)(?:\s+(\{[^}]+\}))?/);
  if (!match) {
    return { language: info, metadata: {} };
  }

  const language = match[1] || '';
  const metadataStr = match[2];

  if (!metadataStr) {
    return { language, metadata: {} };
  }

  try {
    // Convert JavaScript object notation to JSON
    // First, handle quoted strings to preserve them
    let jsonStr = metadataStr
      .replace(/(\w+):/g, '"$1":');  // Quote keys
    
    // Handle values - match everything after : until comma or closing brace
    jsonStr = jsonStr.replace(/:\s*([^,}]+)/g, (_match, value) => {
      const trimmed = value.trim();
      
      // If already quoted (with single or double quotes), convert to double quotes
      if ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
          (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
        return `: "${trimmed.slice(1, -1)}"`;
      }
      
      // Handle boolean values
      if (trimmed === 'true' || trimmed === 'false') {
        return `: ${trimmed}`;
      }
      
      // Handle numbers
      if (!isNaN(Number(trimmed)) && trimmed !== '') {
        return `: ${trimmed}`;
      }
      
      // Everything else as string
      return `: "${trimmed}"`;
    });

    const metadata = JSON.parse(jsonStr);
    metadata.type = metadata.type || language; // Store the language as type if not set
    return { language, metadata };
  } catch (e) {
    logger.error('Failed to parse metadata:', e);
    return { language: language || '', metadata: { type: language } };
  }
}

/**
 * Generate action button block for code blocks
 */
function generateActionButton(
  action: string,
  language: string,
  content: string,
  confirm?: boolean
): any {
  // Generate a unique action_id based on language and content hash
  const actionId = `${language}_${Buffer.from(content).toString('base64').substring(0, 8)}`;
  
  const button: any = {
    type: "button",
    text: {
      type: "plain_text",
      text: action
    },
    action_id: actionId,
    value: content // Store the script/blockkit content in the button value
  };

  // For blockkit with confirm, we'll open a modal instead of inline confirm
  // For other types, add inline confirmation if requested
  if (confirm && language !== 'blockkit') {
    button.confirm = {
      title: {
        type: "plain_text",
        text: "Confirm Action"
      },
      text: {
        type: "mrkdwn",
        text: `Are you sure you want to ${action}?`
      },
      confirm: {
        type: "plain_text",
        text: "Yes"
      },
      deny: {
        type: "plain_text",
        text: "Cancel"
      }
    };
  }

  return {
    type: "actions",
    elements: [button]
  };
}

/**
 * Custom renderer that collects actionable blocks
 */
class BlockKitRenderer {
  private parsedBlocks: ParsedBlock[] = [];
  private baseRenderer: MarkedExtension["renderer"];

  constructor() {
    this.baseRenderer = {
      // #region Block-level renderers
      space: (token) => token.raw,
      
      code: (token) => {
        const { language, metadata } = parseBlockMetadata(token.lang || '');
        
        // Check if this block has an action or is blockkit
        if (metadata.action || metadata.action_id || language === 'blockkit') {
          // Store this as a parsed block
          this.parsedBlocks.push({
            metadata,
            content: token.text,
            language,
            blocks: language === 'blockkit' ? this.parseBlockKitContent(token.text) : undefined
          });
          
          // If show flag is true AND it's NOT blockkit, include the code in text output
          // For blockkit with show:true, we render the blocks directly, so no need for raw code
          if (metadata.show && language !== 'blockkit') {
            return `\`\`\`${language}\n${token.text}\n\`\`\``;
          }
          return ''; // Don't include in text output
        }
        
        // Regular code block
        return `\`\`\`${language}\n${token.text}\n\`\`\``;
      },
      
      blockquote: function(token) {
        return token.tokens
          .map((t) => ("> " + this.parser.parse([t])).trim())
          .join("\n");
      },
      
      html: (token) => {
        return token.text
          .replace(/<br\s*\/{0,1}>/g, "\n")
          .replace(/<\/{0,1}del>/g, "~")
          .replace(/<\/{0,1}s>/g, "~")
          .replace(/<\/{0,1}strike>/g, "~");
      },
      
      heading: (token) => `${token.text}\n\n`,
      
      hr: (token) => token.raw,
      
      list: function(token) {
        const items = token.ordered
          ? token.items.map(
              (item, i) => {
                const parsed = this.parser.parseInline(item.tokens);
                return `${Number(token.start) + i}. ${parsed}`;
              }
            )
          : token.items.map((item) => {
              const marker = item.task ? (item.checked ? "☒" : "☐") : "-";
              const parsed = this.parser.parseInline(item.tokens);
              return `${marker} ${parsed}`;
            });

        const firstItem = token.items[0]?.raw;
        const indentation = firstItem?.match(/^(\s+)/)?.[0];
        if (!indentation) {
          return items.join("\n");
        }

        const newLine = token.ordered ? `\n${indentation} ` : `\n${indentation}`;
        return newLine + items.join(newLine);
      },
      
      listitem: () => "",
      checkbox: () => "",
      
      paragraph: function(token) {
        return this.parser.parseInline(token.tokens);
      },
      
      table: () => "",
      tablerow: () => "",
      tablecell: () => "",
      
      // #endregion
      
      // #region Inline-level renderers
      
      strong: function(token) {
        const text = this.parser.parseInline(token.tokens);
        return `*${text}*`;
      },
      
      em: function(token) {
        const text = this.parser.parseInline(token.tokens);
        return `_${text}_`;
      },
      
      codespan: (token) => token.raw,
      
      br: () => "",
      
      del: function(token) {
        const text = this.parser.parseInline(token.tokens);
        return `~${text}~`;
      },
      
      link: function(token) {
        const text = this.parser.parseInline(token.tokens);
        const url = cleanUrl(token.href);
        
        return url === text || url === `mailto:${text}` || !text
          ? `<${url}>`
          : `<${url}|${text}>`;
      },
      
      image: () => "",
      
      text: (token) => {
        let text = token.text
          .replaceAll("&", "&amp;")
          .replaceAll("<", "&lt;")
          .replaceAll(">", "&gt;");
          
        // Manually convert **bold** to *bold* and __bold__ to *bold*
        text = text.replace(/\*\*(.*?)\*\*/g, '*$1*');
        text = text.replace(/__(.*?)__/g, '*$1*');
        
        return text;
      },
      
      // #endregion
    } satisfies MarkedExtension["renderer"];
  }

  private parseBlockKitContent(content: string): any[] | undefined {
    try {
      // Handle case where opening brace was in the fence header
      let jsonContent = content.trim();
      if (!jsonContent.startsWith('{') && !jsonContent.startsWith('[')) {
        jsonContent = '{' + jsonContent; // Add missing opening brace
      }
      
      const parsed = JSON.parse(jsonContent);
      return parsed.blocks || [parsed];
    } catch (e) {
      logger.error('Failed to parse blockkit JSON:', e);
      logger.error('Content attempted:', content.substring(0, 200));
      return undefined;
    }
  }

  setMarkedInstance(_instance: Marked): void {
    // Method kept for compatibility, no longer storing instance
  }

  getRenderer(): MarkedExtension["renderer"] {
    return this.baseRenderer;
  }

  getBlocks(): ParsedBlock[] {
    return this.parsedBlocks;
  }

  reset(): void {
    this.parsedBlocks = [];
  }
}

function cleanUrl(href: string) {
  try {
    return encodeURI(href).replace(/%25/g, "%");
  } catch {
    return href;
  }
}

/**
 * Convert markdown to Slack format with actionable blocks support
 * Supports blockkit, bash, python, js/ts code blocks with action buttons
 */
export function markdownToSlackWithBlocks(markdown: string): SlackMessage {
  const renderer = new BlockKitRenderer();
  
  // Create a new marked instance to avoid conflicts with global configuration
  const markedInstance = new Marked();
  markedInstance.use({ renderer: renderer.getRenderer() });
  
  // Pass the marked instance back to the renderer so it can use it for recursive parsing
  renderer.setMarkedInstance(markedInstance);
  
  let text: string;
  try {
    text = markedInstance
      .parse(markdown, {
        async: false,
        gfm: true,
      })
      .trimEnd();
  } catch (error) {
    // If markdown parsing fails, fall back to plain text
    logger.error("Markdown parsing failed, using plain text:", error);
    text = markdown;
  }
  
  const parsedBlocks = renderer.getBlocks();
  
  // Build the final Slack message
  const message: SlackMessage = { text };
  
  if (parsedBlocks.length > 0) {
    const allBlocks: any[] = [];
    
    // Add a text section if we have text content
    if (text.trim()) {
      allBlocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: text
        }
      });
    }
    
    // Add blocks for each parsed block
    for (const parsed of parsedBlocks) {
      const { metadata, content, language, blocks } = parsed;
      
      if (language === 'blockkit') {
        // For blockkit, check if we should show the blocks directly or create a button
        if (metadata.show && blocks) {
          // Show the blocks directly in the message
          allBlocks.push(...blocks);
        } else if (metadata.action) {
          // Create a button that will open a modal with the blockkit content
          const actionBlock = generateActionButton(
            metadata.action,
            language,
            JSON.stringify({ blocks: blocks || [] }),
            metadata.confirm
          );
          allBlocks.push(actionBlock);
        }
      } else if (metadata.action) {
        // Generate action button for executable code blocks
        const actionBlock = generateActionButton(
          metadata.action,
          language,
          content,
          metadata.confirm
        );
        allBlocks.push(actionBlock);
      }
    }
    
    message.blocks = allBlocks;
  }
  
  return message;
}

/**
 * Export parsed blocks for action handling
 */
export function extractActionableBlocks(markdown: string): ParsedBlock[] {
  const renderer = new BlockKitRenderer();
  
  // Create a new marked instance to avoid conflicts with global configuration
  const markedInstance = new Marked();
  markedInstance.use({ renderer: renderer.getRenderer() });
  
  try {
    markedInstance.parse(markdown, {
      async: false,
      gfm: true,
    });
  } catch (error) {
    // If markdown parsing fails, log the error but continue
    logger.error("Markdown parsing failed in extractActionableBlocks:", error);
  }
  
  return renderer.getBlocks();
}

/**
 * Legacy function for backward compatibility
 */
export function markdownToSlack(markdown: string): string {
  const result = markdownToSlackWithBlocks(markdown);
  return result.text;
}