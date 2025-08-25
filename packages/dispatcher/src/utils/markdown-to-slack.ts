/**
 * Simple markdown to Slack converter for the dispatcher
 * Handles basic markdown formatting to make messages readable in Slack
 */

interface SlackMessage {
  text: string;
  blocks?: any[];
}

/**
 * Convert common markdown patterns to Slack format
 */
function convertMarkdownToSlack(text: string): string {
  return text
    // Convert headers to bold
    .replace(/^### (.*$)/gim, '*$1*')
    .replace(/^## (.*$)/gim, '*$1*') 
    .replace(/^# (.*$)/gim, '*$1*')
    // Convert bold and italic
    .replace(/\*\*(.*?)\*\*/g, '*$1*')
    .replace(/\*(.*?)\*/g, '_$1_')
    // Convert inline code
    .replace(/`([^`]+)`/g, '`$1`')
    // Convert links [text](url) to <url|text>
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<$2|$1>')
    // Convert simple lists
    .replace(/^[\*\-\+] (.*$)/gim, '• $1');
}

/**
 * Simple markdown to Slack blocks conversion
 * This is a lightweight version focused on readability
 */
export function markdownToSlackBlocks(markdown: string): SlackMessage {
  const text = convertMarkdownToSlack(markdown);
  const blocks: any[] = [];

  // Split content by double newlines to create sections
  const sections = text.split('\n\n').filter(section => section.trim());
  
  for (const section of sections) {
    const trimmed = section.trim();
    if (!trimmed) continue;

    // Check if this is a code block with or without metadata
    const codeBlockWithMetadataMatch = trimmed.match(/^```(\w+)\s*\{([^}]+)\}\s*\n([\s\S]*?)```$/);
    const basicCodeBlockMatch = trimmed.match(/^```(\w*)\n?([\s\S]*?)```$/);
    
    if (codeBlockWithMetadataMatch) {
      // Code block with metadata
      const [, language, metadataStr, code] = codeBlockWithMetadataMatch;
      
      // Parse metadata
      const metadata: any = {};
      if (metadataStr) {
        metadataStr.split(',').forEach(pair => {
          const [key, value] = pair.split(':').map(s => s.trim());
          if (key && value) {
            const cleanKey = key.replace(/"/g, '');
            let cleanValue: any = value.replace(/"/g, '');
            if (cleanValue === 'true') cleanValue = true;
            if (cleanValue === 'false') cleanValue = false;
            metadata[cleanKey] = cleanValue;
          }
        });
      }
      
      // Skip rendering if show:false
      if (metadata.show === false) {
        continue;
      }
      
      // Add code block if show is not false
      blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: `\`\`\`${language || ''}\n${(code || '').trim()}\`\`\``
        }
      });
      continue;
    } else if (basicCodeBlockMatch) {
      // Basic code block without metadata
      const [, language, code] = basicCodeBlockMatch;
      
      // Add code block
      blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: `\`\`\`${language || ''}\n${(code || '').trim()}\`\`\``
        }
      });
      continue;
    }

    // Regular section
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: trimmed
      }
    });
  }

  // If no blocks were created, create a simple text block
  if (blocks.length === 0) {
    blocks.push({
      type: "section", 
      text: {
        type: "mrkdwn",
        text: text
      }
    });
  }

  return { text, blocks };
}