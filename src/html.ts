// Text <-> the HTML Jelly's editor makes. Replies and notes are written as plain
// text; links become <a> tags the way people's own replies in Jelly do them:
//   someone@example.com  -> <a href="mailto:someone@example.com">someone@example.com</a>
//   hackclub.com/haven   -> <a href="https://hackclub.com/haven">hackclub.com/haven</a>
//   [the form](https://…) -> <a href="https://…">the form</a>
// (From pudding's reply-html.ts.)

// Bare domains only count with one of these endings, so "Node.js" or "index.html" stay text.
const TLDS = "com|org|net|edu|gov|io|co|club|dev|app|ai|gg|xyz|info|uk|ca";
const EMAIL = String.raw`[\w.+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}`;
const URL_RE = String.raw`https?:\/\/[^\s<>"]+`;
const DOMAIN = String.raw`(?:[a-z0-9-]+\.)+(?:${TLDS})\b(?:\/[^\s<>"]*)?`;
const MARKDOWN = String.raw`\[([^\]\n]+)\]\((${URL_RE}|mailto:${EMAIL}|${DOMAIN})\)`;

const LINK_RE = new RegExp(`${MARKDOWN}|(${EMAIL})|(${URL_RE})|(?<![\\w.@/-])(${DOMAIN})`, "gi");

export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function anchor(href: string, text: string): string {
  return `<a href="${escapeHtml(href)}">${escapeHtml(text)}</a>`;
}

/** "https://x.org/a." -> ["https://x.org/a", "."]: punctuation ending a sentence isn't part of the link. */
function splitTrailing(link: string): [string, string] {
  let end = link.length;
  while (end > 0) {
    const c = link[end - 1]!;
    const head = link.slice(0, end);
    const unbalanced = c === ")" && head.split("(").length < head.split(")").length;
    if (!".,;:!?'\"’]".includes(c) && !unbalanced) break;
    end--;
  }
  return [link.slice(0, end), link.slice(end)];
}

function withScheme(link: string): string {
  return /^(https?:\/\/|mailto:)/i.test(link) ? link : `https://${link}`;
}

/** One line of text with links as <a>; `inline` turns other spans (like @mentions) into raw HTML. */
function linkify(line: string, inline?: (escapedText: string) => string): string {
  const text = (s: string) => (inline ? inline(escapeHtml(s)) : escapeHtml(s));
  let html = "";
  let last = 0;
  for (const m of line.matchAll(LINK_RE)) {
    const [whole, label, target, email, url, domain] = m;
    html += text(line.slice(last, m.index));
    last = m.index + whole.length;
    if (label !== undefined && target !== undefined) html += anchor(withScheme(target), label);
    else if (email !== undefined) html += anchor(`mailto:${email}`, email);
    else {
      const [link, after] = splitTrailing(url ?? domain ?? "");
      html += (link ? anchor(withScheme(link), link) : "") + escapeHtml(after);
    }
  }
  return html + text(line.slice(last));
}

/** One <div> per line, <div><br></div> for blank lines, links as <a>. */
export function textToHtml(text: string, inline?: (escapedText: string) => string): string {
  return text
    .replace(/\r\n/g, "\n")
    .trim()
    .split("\n")
    .map((line) => (line.trim() === "" ? "<div><br></div>" : `<div>${linkify(line, inline)}</div>`))
    .join("");
}

// Jelly's box starts with empty lines for typing in ("<br>\n<br>\n" above the
// signature); any mix of these is dropped.
const LEADING_BLANK = /^(?:\s|&nbsp;|<br\s*\/?>|<(div|p)>(?:\s|&nbsp;|<br\s*\/?>)*<\/\1>)+/i;

/**
 * The text goes above whatever Jelly pre-filled (signature, quoted email), with
 * the signature on the very next line. With no signature, one blank line
 * separates the text from the quote.
 */
export function composeHtmlBody(text: string, prefilled: string): string {
  const rest = prefilled.replace(LEADING_BLANK, "");
  const gap = rest === "" || /^<div[^>]*\bjelly-signature\b/i.test(rest) ? "" : "<div><br></div>";
  return `${textToHtml(text)}${gap}${rest}`;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

export function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, code: string) => {
    if (code.startsWith("#x") || code.startsWith("#X")) return String.fromCodePoint(parseInt(code.slice(2), 16));
    if (code.startsWith("#")) return String.fromCodePoint(parseInt(code.slice(1), 10));
    return ENTITIES[code.toLowerCase()] ?? match;
  });
}

/** A link as a reply's text writes it: the bare address when that's what it shows, else [text](url). */
function linkText(href: string, inner: string): string {
  const text = inner.replace(/<[^>]+>/g, "").replace(/&nbsp;/gi, " ").trim();
  if (text === "") return href;
  const bare = (s: string) =>
    s.toLowerCase().replace(/^(mailto:|https?:\/\/)/, "").replace(/^www\./, "").replace(/\/$/, "");
  return bare(text) === bare(href) ? text : `[${text}](${href})`;
}

export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<(script|style|head|template)[\s\S]*?<\/\1>/gi, "")
      .replace(/<blockquote[\s\S]*?<\/blockquote>/gi, (q) => q.replace(/^/gm, "> "))
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|li|tr|h[1-6]|blockquote)>/gi, "\n")
      .replace(/<a\s[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, href: string, inner: string) =>
        linkText(href, inner),
      )
      .replace(/<[^>]+>/g, ""),
  )
    .replace(/ /g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Collapses whitespace, for one-line labels pulled out of HTML. */
export function squish(text: string): string {
  return decodeEntities(text).replace(/\s+/g, " ").trim();
}
