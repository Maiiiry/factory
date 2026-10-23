import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";
import { errorMessage } from "./text.js";

/** The ATX headings and fenced-code boundaries used by source selectors. */
export function markdownLines(content: string): {
  text: string;
  fenced: boolean;
  heading?: { level: number; text: string };
}[] {
  let fence: { marker: string; length: number } | undefined;
  return content.split("\n").map((text) => {
    const line = text.replace(/\r$/, "");
    const delimiter = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (fence) {
      if (
        delimiter &&
        delimiter[1]![0] === fence.marker &&
        delimiter[1]!.length >= fence.length &&
        /^[ \t]*$/.test(delimiter[2]!)
      )
        fence = undefined;
      return { text, fenced: true };
    }
    if (
      delimiter &&
      (delimiter[1]![0] !== "`" || !delimiter[2]!.includes("`"))
    ) {
      fence = { marker: delimiter[1]![0]!, length: delimiter[1]!.length };
      return { text, fenced: true };
    }
    const match = line.match(/^ {0,3}(#{1,6})(?:[ \t]+(.*)|[ \t]*)$/);
    return {
      text,
      fenced: false,
      ...(match
        ? {
            heading: {
              level: match[1]!.length,
              text: (match[2] ?? "")
                .replace(/(?:^|[ \t]+)#+[ \t]*$/, "")
                .trim(),
            },
          }
        : {}),
    };
  });
}

/** GitHub renders an unanswered optional issue-form field as this one line. */
export function githubEmptyField(line: {
  text: string;
  fenced: boolean;
}): boolean {
  return !line.fenced && line.text.trim() === "_No response_";
}

/** Characters GitHub shows as nothing: zero-width, bidi controls, tag characters. */
const INVISIBLE =
  /[\u00AD\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]|[\u{E0000}-\u{E007F}]/gu;

/**
 * What an HTML parser hides inside raw HTML: comments (an unclosed one runs
 * to the end), processing instructions, CDATA and declarations.
 */
const HIDDEN_HTML =
  /<!--(?:>|->|[\s\S]*?(?:-->|$))|<\?[\s\S]*?(?:\?>|$)|<!\[CDATA\[[\s\S]*?(?:\]\]>|$)|<![A-Za-z][\s\S]*?(?:>|$)/g;

/** Markdown Factory can't parse, so it can't tell what GitHub shows. */
export class UnreadableMarkdown extends Error {}

interface MarkdownNode {
  type: string;
  position?: { start: { offset?: number }; end: { offset?: number } };
  children?: MarkdownNode[];
}

/**
 * Markdown as GitHub shows it, for text a person approved by reading the
 * rendered issue. A CommonMark + GFM parser finds what the reader never
 * sees: comments (and the like) inside raw HTML, and link reference
 * definitions. Those source ranges are cut, a line left blank by a cut is
 * dropped, and invisible characters are removed; everything else stays as
 * written, so headings and sections survive. Throws UnreadableMarkdown
 * when the parser fails: the caller holds rather than pass text through.
 */
export function visibleMarkdown(content: string): string {
  // GitHub shows NUL as U+FFFD; NUL then marks the cuts below.
  const source = content.replace(/\r\n?/g, "\n").replace(/\0/g, "\uFFFD");
  let tree: MarkdownNode;
  try {
    tree = fromMarkdown(source, {
      extensions: [gfm()],
      mdastExtensions: [gfmFromMarkdown()],
    });
  } catch (error) {
    throw new UnreadableMarkdown(errorMessage(error));
  }
  const cuts: [number, number][] = [];
  const visit = (node: MarkdownNode): void => {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (node.type === "definition" || node.type === "html") {
      if (start === undefined || end === undefined)
        throw new UnreadableMarkdown(`a ${node.type} node has no position`);
      if (node.type === "definition") cuts.push([start, end]);
      else
        for (const hidden of source.slice(start, end).matchAll(HIDDEN_HTML))
          cuts.push([
            start + hidden.index,
            start + hidden.index + hidden[0].length,
          ]);
    }
    for (const child of node.children ?? []) visit(child);
  };
  visit(tree);
  let marked = "";
  let at = 0;
  for (const [start, end] of cuts.sort((a, b) => a[0] - b[0])) {
    if (end <= at) continue;
    marked += `${source.slice(at, Math.max(at, start))}\0`;
    at = end;
  }
  marked += source.slice(at);
  return marked
    .split("\n")
    .flatMap((line) => {
      if (!line.includes("\0")) return [line];
      const kept = line.replaceAll("\0", "");
      return kept.trim() ? [kept] : [];
    })
    .join("\n")
    .replace(INVISIBLE, "");
}
