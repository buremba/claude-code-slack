import { MarkedExtension, Marked } from "marked";

/**
 * Docs: https://marked.js.org/using_pro#renderer
 * HTML implementation example: https://github.com/markedjs/marked/blob/aa7a8a2b8944c00b2de8f4093a90a9990a2d6391/src/Renderer.ts#L14
 */
const renderer = {
  // #region Block-level renderers

  space(token) {
    return token.raw;
  },

  code(token) {
    return `\`\`\`${token.lang ?? ""}\n${token.text}\n\`\`\``;
  },

  blockquote(token) {
    return token.tokens
      .map((t) => ("> " + this.parser.parse([t])).trim())
      .join("\n");
  },

  html(token) {
    return token.text
      .replace(/<br\s*\/{0,1}>/g, "\n")
      .replace(/<\/{0,1}del>/g, "~")
      .replace(/<\/{0,1}s>/g, "~")
      .replace(/<\/{0,1}strike>/g, "~");
  },

  heading(token) {
    return `${token.text}\n\n`;
  },

  hr(token) {
    return token.raw;
  },

  list(token) {
    const items = token.ordered
      ? token.items.map(
          (item, i) =>
            `${Number(token.start) + i}. ${this.parser.parse(item.tokens)}`,
        )
      : token.items.map((item) => {
          const marker = item.task ? (item.checked ? "☒" : "☐") : "-";
          return `${marker} ${this.parser.parse(item.tokens)}`;
        });

    const firstItem = token.items[0]?.raw;
    const indentation = firstItem?.match(/^(\s+)/)?.[0];
    if (!indentation) {
      return items.join("\n");
    }

    // If we have leading indentation, nest the list and preserve it
    // Somehow, nested ordered lists are missing 1 space in raw indentation
    const newLine = token.ordered ? `\n${indentation} ` : `\n${indentation}`;
    return newLine + items.join(newLine);
  },

  listitem() {
    return "";
  },

  checkbox() {
    return "";
  },

  paragraph(token) {
    return this.parser.parseInline(token.tokens);
  },

  table() {
    return "";
  },

  tablerow() {
    return "";
  },

  tablecell() {
    return "";
  },

  // #endregion

  // #region Inline-level renderers

  strong(token) {
    const text = this.parser.parseInline(token.tokens);
    return `*${text}*`;
  },

  em(token) {
    const text = this.parser.parseInline(token.tokens);
    return `_${text}_`;
  },

  codespan(token) {
    return token.raw;
  },

  br() {
    return "";
  },

  del(token) {
    const text = this.parser.parseInline(token.tokens);
    return `~${text}~`;
  },

  link(token) {
    const text = this.parser.parseInline(token.tokens);
    const url = cleanUrl(token.href);

    return url === text || url === `mailto:${text}` || !text
      ? `<${url}>`
      : `<${url}|${text}>`;
  },

  image() {
    // Images are not supported by mrkdwn. Use Slack Block Kit for that.
    return "";
  },

  text(token) {
    return (
      token.text
        // Escaped characters: https://api.slack.com/reference/surfaces/formatting#escaping
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
    );
  },

  // #endregion
} satisfies MarkedExtension["renderer"];

function cleanUrl(href: string) {
  try {
    return encodeURI(href).replace(/%25/g, "%");
  } catch {
    return href;
  }
}

export function markdownToSlack(markdown: string): string {
  const markedInstance = new Marked();
  markedInstance.use({ renderer });
  
  return markedInstance
    .parse(markdown, {
      // Available options: https://marked.js.org/using_advanced#options
      async: false,
      gfm: true,
    })
    .trimEnd();
}