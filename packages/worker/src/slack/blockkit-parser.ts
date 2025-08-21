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
 * Claude CLI slash commands with descriptions
 */
const CLAUDE_SLASH_COMMANDS = [
  { value: "/bug", description: "Report bugs (sends conversation to Anthropic)" },
  { value: "/clear", description: "Clear conversation history" },
  { value: "/compact", description: "Compact conversation with optional focus instructions" },
  { value: "/config", description: "View/modify configuration" },
  { value: "/cost", description: "Show token usage statistics" },
  { value: "/doctor", description: "Checks the health of your Claude Code installation" },
  { value: "/help", description: "Get usage help" },
  { value: "/init", description: "Initialize project with CLAUDE.md guide" },
  { value: "/login", description: "Switch Anthropic accounts" },
  { value: "/logout", description: "Sign out from your Anthropic account" },
  { value: "/mcp", description: "Manage MCP server connections and OAuth authentication" },
  { value: "/memory", description: "Edit CLAUDE.md memory files" },
  { value: "/model", description: "Select or change the AI model" },
  { value: "/permissions", description: "View or update permissions" },
  { value: "/pr_comments", description: "View pull request comments" },
  { value: "/review", description: "Request code review" },
  { value: "/status", description: "View account and system statuses" },
  { value: "/terminal-setup", description: "Install Shift+Enter key binding for newlines" },
  { value: "/vim", description: "Enter vim mode for alternating insert and command modes" }
];


/**
 * Generate bottom control section with context info and controls
 */
function generateBottomControlSection(contextInfo?: string, actionButtons?: any[]): any[] {
  const blocks: any[] = [];
  
  // Create the slash command options
  const options = CLAUDE_SLASH_COMMANDS.map(cmd => ({
    text: {
      type: "plain_text",
      text: `${cmd.value} - ${cmd.description.length > 50 ? cmd.description.substring(0, 47) + '...' : cmd.description}`
    },
    value: cmd.value,
    description: {
      type: "plain_text",
      text: cmd.description.length > 75 ? cmd.description.substring(0, 72) + '...' : cmd.description
    }
  }));
  
  // First add context as a section if it exists
  if (contextInfo) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: contextInfo
      }
    });
  }
  
  // Then add actions block with all buttons and dropdown
  const elements: any[] = [...(actionButtons || [])];
  elements.push({ 
    type: "static_select",
    placeholder: {
      type: "plain_text",
      text: "Commands"
    },
    action_id: "claude_slash_command_select",
    options: options
  });
  
  blocks.push({
    type: "actions",
    elements: elements
  });
  
  return blocks;
}

/**
 * Convert markdown text to Slack formatting
 */
function convertMarkdownToSlack(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    // Convert **bold** and __bold__ to *bold* for Slack
    .replace(/\*\*(.*?)\*\*/g, '*$1*')
    .replace(/__(.*?)__/g, '*$1*');
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
      
      heading: function(token) {
        const text = this.parser.parseInline(token.tokens);
        return `${convertMarkdownToSlack(text)}\n\n`;
      },
      
      hr: (token) => token.raw,
      
      list: function(token) {
        const items = token.ordered
          ? token.items.map(
              (item, i) => {
                // Use the raw text and apply Slack formatting manually
                const text = item.text || item.raw || '';
                const parsed = convertMarkdownToSlack(text.trim());
                return `${Number(token.start) + i}. ${parsed}`;
              }
            )
          : token.items.map((item) => {
              const marker = item.task ? (item.checked ? "☒" : "☐") : "-";
              // Use the raw text and apply Slack formatting manually
              const text = item.text || item.raw || '';
              const parsed = convertMarkdownToSlack(text.trim());
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
      
      text: (token) => convertMarkdownToSlack(token.text),
      
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
export function markdownToSlackWithBlocks(markdown: string, contextInfo?: string): SlackMessage {
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
    const actionButtons: any[] = [];
    
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
    
    // Process parsed blocks - collect action buttons separately
    for (const parsed of parsedBlocks) {
      const { metadata, content, language, blocks } = parsed;
      
      if (language === 'blockkit') {
        // For blockkit, check if we should show the blocks directly or create a button
        if (metadata.show && blocks) {
          // Show the blocks directly in the message
          allBlocks.push(...blocks);
        } else if (metadata.action) {
          // Create a button for the blockkit content
          const button: any = {
            type: "button",
            text: {
              type: "plain_text",
              text: metadata.action
            },
            action_id: `blockkit_${Buffer.from(JSON.stringify({ blocks: blocks || [] })).toString('base64').substring(0, 8)}`,
            value: JSON.stringify({ blocks: blocks || [] })
          };
          if (metadata.confirm && language !== 'blockkit') {
            button.confirm = {
              title: {
                type: "plain_text",
                text: "Confirm Action"
              },
              text: {
                type: "mrkdwn",
                text: `Are you sure you want to ${metadata.action}?`
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
          actionButtons.push(button);
        }
      } else if (metadata.action) {
        // Create button for executable code blocks
        const button: any = {
          type: "button",
          text: {
            type: "plain_text",
            text: metadata.action
          },
          action_id: `${language}_${Buffer.from(content).toString('base64').substring(0, 8)}`,
          value: content
        };
        if (metadata.confirm) {
          button.confirm = {
            title: {
              type: "plain_text",
              text: "Confirm Action"
            },
            text: {
              type: "mrkdwn",
              text: `Are you sure you want to ${metadata.action}?`
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
        actionButtons.push(button);
      }
    }
    
    // Add divider and bottom control section with context and all controls
    allBlocks.push({ type: "divider" });
    allBlocks.push(...generateBottomControlSection(contextInfo, actionButtons));
    
    message.blocks = allBlocks;
  } else {
    // Even if no parsed blocks, add bottom control section if we have text content
    if (text.trim()) {
      const allBlocks: any[] = [];
      
      allBlocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: text
        }
      });
      
      allBlocks.push({ type: "divider" });
      allBlocks.push(...generateBottomControlSection(contextInfo));
      
      message.blocks = allBlocks;
    }
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