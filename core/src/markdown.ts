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
  identifier?: string;
  position?: { start: { offset?: number }; end: { offset?: number } };
  children?: MarkdownNode[];
}

/**
 * Markdown as GitHub shows it, for text a person approved by reading the
 * rendered issue. A CommonMark + GFM parser finds what the reader never
 * sees: comments (and the like) inside raw HTML, and link or footnote
 * definitions nothing shown references or that repeat an earlier label.
 * Those source ranges are cut, a line left blank by a cut is dropped, and
 * invisible characters are removed; everything else stays as written, so
 * headings and sections survive. Throws UnreadableMarkdown when the parser
 * fails: the caller holds rather than pass text through. This is the
 * producer only: renderedText checks its result against GitHub's renderer.
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
  // GitHub (cmark-gfm) resolves a label to its first definition, renders a
  // footnote only when shown text references it, and shows nothing for an
  // unreferenced link definition. So a footnote referenced only from an
  // unshown footnote stays hidden, and only first definitions count.
  interface Scope {
    notes: string[];
    links: string[];
  }
  const top: Scope = { notes: [], links: [] };
  const footnotes = new Map<string, Scope>();
  const firsts = new Set<MarkdownNode>();
  const defined = new Set<string>();
  const collect = (node: MarkdownNode, scope: Scope): void => {
    const id = node.identifier;
    if (node.type === "footnoteReference" && id) scope.notes.push(id);
    if (
      (node.type === "linkReference" || node.type === "imageReference") &&
      id !== undefined
    )
      scope.links.push(id);
    if (node.type === "footnoteDefinition" && id !== undefined) {
      // A later duplicate's references go to a scope nothing reads.
      scope = { notes: [], links: [] };
      if (!footnotes.has(id)) {
        footnotes.set(id, scope);
        firsts.add(node);
      }
    }
    if (node.type === "definition" && id !== undefined && !defined.has(id)) {
      defined.add(id);
      firsts.add(node);
    }
    for (const child of node.children ?? []) collect(child, scope);
  };
  collect(tree, top);
  const shown = new Set<string>();
  const linked = new Set(top.links);
  const pending = [...top.notes];
  for (let id = pending.pop(); id !== undefined; id = pending.pop())
    if (!shown.has(id)) {
      shown.add(id);
      const scope = footnotes.get(id);
      pending.push(...(scope?.notes ?? []));
      for (const link of scope?.links ?? []) linked.add(link);
    }
  const cuts: [number, number][] = [];
  const visit = (node: MarkdownNode): void => {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    const id = node.identifier ?? "";
    const unshown =
      (node.type === "footnoteDefinition" &&
        !(firsts.has(node) && shown.has(id))) ||
      (node.type === "definition" && !(firsts.has(node) && linked.has(id)));
    if (node.type === "html" || unshown) {
      if (start === undefined || end === undefined)
        throw new UnreadableMarkdown(`a ${node.type} node has no position`);
      if (node.type !== "html") {
        cuts.push([start, end]);
        return;
      }
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

/** An HTML start or end tag; quoted attribute values may hold `>`. */
const HTML_TAG = /<\/?[A-Za-z][^\s/>]*(?:[^>"']|"[^"]*"|'[^']*')*>/g;

/** Footnote back-links: renderer chrome, not the author's text. */
const BACKREF =
  /<a(?=\s)(?=(?:[^>"']|"[^"]*"|'[^']*')*?\sdata-footnote-backref[\s=>])(?:[^>"']|"[^"]*"|'[^']*')*>[\s\S]*?<\/a>/g;

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: "\u00A0",
};

/**
 * The text a reader sees in GitHub-rendered HTML, for comparing two
 * renderings: comments, footnote back-links and tags (with their
 * attributes: ids, hrefs, anchors) are dropped, a tag counts as a space,
 * entities are decoded, invisible characters removed and whitespace
 * collapsed. An entity it doesn't know stays as written, on both sides.
 */
export function renderedText(html: string): string {
  return html
    .replace(/<!--[\s\S]*?(?:-->|$)/g, "")
    .replace(BACKREF, "")
    .replace(HTML_TAG, " ")
    .replace(
      /&(?:#(\d{1,7})|#[xX]([0-9A-Fa-f]{1,6})|([A-Za-z]+));/g,
      (entity, decimal?: string, hex?: string, name?: string) => {
        if (name) return ENTITIES[name] ?? entity;
        const point = decimal ? Number(decimal) : Number.parseInt(hex!, 16);
        return point > 0 && point <= 0x10ffff
          ? String.fromCodePoint(point)
          : "\uFFFD";
      },
    )
    .replace(INVISIBLE, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Where two texts first differ, as a short excerpt of each. */
export function firstDifference(
  a: string,
  b: string,
): { a: string; b: string } {
  let at = 0;
  while (at < a.length && a[at] === b[at]) at++;
  const from = Math.max(0, at - 20);
  return { a: a.slice(from, at + 40), b: b.slice(from, at + 40) };
}
