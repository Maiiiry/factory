import type { Element, ElementContent, Properties, RootContent } from "hast";
import { fromHtml } from "hast-util-from-html";
import { toMdast } from "hast-util-to-mdast";
import { gfmToMarkdown } from "mdast-util-gfm";
import { type Handle, toMarkdown } from "mdast-util-to-markdown";

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
const EMPTY_FIELD = "_No response_";

/** The empty-field line, with either emphasis marker. */
export function githubEmptyField(line: {
  text: string;
  fenced: boolean;
}): boolean {
  const text = line.text.trim();
  return !line.fenced && (text === EMPTY_FIELD || text === "*No response*");
}

/**
 * Characters GitHub shows as nothing: zero-width, bidi controls, tag
 * characters. They are removed from the tree, so the only one in the
 * output is the line-start marker `text` adds.
 */
const INVISIBLE =
  /[\u00AD\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]|[\u{E0000}-\u{E007F}]/gu;

/**
 * The Markdown a reader sees in GitHub's rendering of an issue body
 * (`body_html`), for text a person approved by reading the rendered issue.
 * GitHub's own renderer and sanitizer decide what is shown; this only
 * converts the result back (hast-util-from-html, hast-util-to-mdast,
 * mdast-util-to-markdown with GFM). Kept: text, headings, lists and task
 * lists, tables, code blocks (mermaid and math sources as code), and links
 * as their text plus href. An image or video is `[image: <file name>]`,
 * another rendered diagram `[<type> diagram]`. Every other attribute (alt,
 * title, data-*), every comment and everything the sanitizer removed is
 * gone, so nothing GitHub doesn't show reaches a model. Footnotes stay as
 * GitHub's rendered section, a reference as `[n]`.
 *
 * Text is written as shown, without Markdown escapes, so a path or heading
 * reads as the reader sees it (`src/_internal.ts`, `A&B`, `[draft]`). Only
 * block structure is emitted as Markdown; a shown line that would read as
 * a heading or code fence starts with U+200B (see `text`).
 */
export function shownMarkdown(html: string): string {
  const tree = fromHtml(html, { fragment: true });
  const mdast = toMdast(
    { type: "root", children: shown(tree.children) },
    // A placeholder is written as is: `[image: a.png]`, not `\[image: a.png]`.
    {
      handlers: {
        [LITERAL]: (_, node) => ({ type: "html", value: textOf(node) }),
      },
    },
  );
  return toMarkdown(mdast, {
    extensions: [gfmToMarkdown()],
    // A line break is the line break shown, not a trailing `\\`.
    handlers: { text, break: () => "\n" },
    bullet: "-",
    // The markers people put in paths and headings: `x/__tests__/a.ts`
    // (shown bold) and `#Step *x*` come back as written.
    emphasis: "*",
    strong: "_",
    rule: "-",
  }).trim();
}

/** A shown line that markdownLines would read as a heading or code fence. */
const BLOCK_START = /^([ \t]{0,3}(?:#{1,6}(?:[ \t]|$)|`{3}|~{3}))/;

/**
 * Text as shown: no Markdown escapes. GitHub showed this text as text, so
 * a line of it that would read as a heading or fence (`\## Acceptance`
 * renders as the paragraph "## Acceptance") starts with a zero-width space,
 * and an Objective section or fence can only come from GitHub's own
 * headings and code blocks. A `|` in a table cell stays `\|`: the cell
 * boundary is structure.
 */
const text: Handle = (node, _, state, info) => {
  let value: string = node.value;
  if (state.stack.includes("tableCell")) value = value.replace(/\|/g, "\\|");
  return value
    .split("\n")
    .map((line, index) =>
      index > 0 || /\n$|^$/.test(info.before)
        ? line.replace(BLOCK_START, "\u200B$1")
        : line,
    )
    .join("\n");
};

/** Attributes whose effect a reader sees; every other attribute is dropped. */
const KEPT: Record<string, string[]> = {
  a: ["href"],
  input: ["type", "checked"],
  ol: ["start"],
};

/** Factory's own placeholder text; never a tag GitHub's sanitizer lets through. */
const LITERAL = "factory-shown-literal";

const literal = (value: string): Element =>
  element(LITERAL, {}, [{ type: "text", value }]);

const MEDIA: Record<string, string> = {
  img: "image",
  video: "video",
  audio: "audio",
};

/** The shown part of GitHub-rendered HTML, with only the KEPT attributes. */
function shown(nodes: readonly RootContent[]): ElementContent[] {
  return nodes.flatMap((node): ElementContent[] => {
    if (node.type === "text") return [{ ...node, value: visible(node.value) }];
    if (node.type !== "element") return [];
    const { properties: p, children } = node;
    const tag = node.tagName === LITERAL ? "span" : node.tagName;
    // Footnote back-links are renderer chrome; a reference is its number.
    if (p.dataFootnoteBackref !== undefined) return [];
    if (p.dataFootnoteRef !== undefined) return [literal(`[${textOf(node)}]`)];
    // A rendered diagram: a mermaid source shows as its drawing, as code;
    // another type (geojson, topojson, stl, ...) shows a map or model, not
    // its source, so only its type is kept.
    if (tag === "section" && p.dataType !== undefined) {
      const type = String(p.dataType).replace(/[^\w-]/g, "");
      return type === "mermaid"
        ? find(node, "pre").flatMap((pre) => shown([pre]))
        : [element("p", {}, [literal(`[${type || "unknown"} diagram]`)])];
    }
    if (tag === "pre") {
      const lang = language(node);
      const source = textOf(node);
      return [codeBlock(lang === "mermaid" ? drawn(source) : source, lang)];
    }
    // A blank issue-form field: the one marker githubEmptyField reads.
    if (tag === "p" && emptyField(node))
      return [element("p", {}, [literal(EMPTY_FIELD)])];
    if (tag === "math-renderer") {
      const source = textOf(node);
      return classes(p).includes("js-display-math")
        ? [codeBlock(source.replace(/^\$\$|\$\$$/g, ""), "math")]
        : [element("code", {}, [{ type: "text", value: source }])];
    }
    const kind = MEDIA[tag];
    if (kind) return [literal(`[${kind}: ${fileName(p)}]`)];
    // GitHub links every image to itself: the image is what shows.
    const only = children.filter(
      (child) => child.type !== "text" || child.value.trim(),
    );
    if (
      tag === "a" &&
      only.length === 1 &&
      only[0]!.type === "element" &&
      only[0]!.tagName === "img" &&
      only[0]!.properties.src === p.href
    )
      return shown(only);
    const kept: Properties = {};
    for (const name of KEPT[tag] ?? []) {
      const value = p[name];
      if (value !== undefined)
        kept[name] = typeof value === "string" ? visible(value) : value;
    }
    return [element(tag, kept, shown(children))];
  });
}

function element(
  tagName: string,
  properties: Properties,
  children: ElementContent[],
): Element {
  return { type: "element", tagName, properties, children };
}

function codeBlock(value: string, lang: string | undefined): Element {
  return element("pre", {}, [
    element("code", lang ? { className: [`language-${lang}`] } : {}, [
      { type: "text", value },
    ]),
  ]);
}

/** A code block's language as GitHub kept it: `<pre lang>` or `<code class="language-…">`. */
function language(pre: Element): string | undefined {
  if (typeof pre.properties.lang === "string") return pre.properties.lang;
  for (const code of find(pre, "code"))
    for (const name of classes(code.properties))
      if (name.startsWith("language-")) return name.slice(9);
  return undefined;
}

function classes(p: Properties): string[] {
  return Array.isArray(p.className) ? p.className.map(String) : [];
}

/**
 * The lines of a mermaid source the diagram draws: `%%` comments and
 * `accTitle` / `accDescr` (one line or a `{ ... }` block) are only SVG
 * metadata, never drawn.
 */
function drawn(source: string): string {
  let block = false;
  return source
    .split("\n")
    .filter((line) => {
      if (block) {
        block = !line.includes("}");
        return false;
      }
      const open = line.match(/^\s*accDescr\s*\{(.*)$/);
      if (open) {
        block = !open[1]!.includes("}");
        return false;
      }
      return !/^\s*(?:%%|acc(?:Title|Descr)\s*:)/.test(line);
    })
    .join("\n");
}

/** GitHub's rendering of a blank issue-form field: `<p><em>No response</em></p>`. */
function emptyField(p: Element): boolean {
  const only = p.children.filter(
    (child) => child.type !== "text" || child.value.trim(),
  );
  return (
    only.length === 1 &&
    only[0]!.type === "element" &&
    only[0]!.tagName === "em" &&
    textOf(only[0]!).trim() === "No response"
  );
}

function visible(value: string): string {
  return value.replace(INVISIBLE, "");
}

function textOf(node: ElementContent): string {
  if (node.type === "text") return visible(node.value);
  if (node.type !== "element") return "";
  return node.children.map(textOf).join("");
}

function find(node: Element, tag: string): Element[] {
  return node.children.flatMap((child) =>
    child.type !== "element"
      ? []
      : child.tagName === tag
        ? [child]
        : find(child, tag),
  );
}

/**
 * A media file's name from its original URL (GitHub proxies the src), still
 * URL-encoded, so it can't carry a space or a line break into the text.
 */
function fileName(p: Properties): string {
  try {
    const url = new URL(String(p.dataCanonicalSrc ?? p.src ?? ""));
    return url.pathname.split("/").pop() || url.host;
  } catch {
    return "unknown";
  }
}
