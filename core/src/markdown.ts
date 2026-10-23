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
const INVISIBLE = /[­᠎​-‏‪-‮⁠-⁤⁦-⁩﻿]|[\u{E0000}-\u{E007F}]/gu;

/** A link reference definition, which GitHub doesn't render; its title is dropped. */
const REFERENCE =
  /^( {0,3}\[[^\]]+\]:[ \t]*(?:<[^>\n]*>|\S+))(?:[ \t]+(?:"[^"]*"|'[^']*'|\([^)]*\)))?[ \t]*$/;

/**
 * Markdown as GitHub shows it, for text a person approved by reading the
 * rendered issue: HTML comments outside code (an unclosed one hides the
 * rest), link reference titles and invisible characters are removed, since
 * the reader never sees them. Fenced code and code spans are kept.
 */
export function visibleMarkdown(content: string): string {
  const out: string[] = [];
  let comment = false;
  let fence: { marker: string; length: number } | undefined;
  for (const text of content.replace(/\r\n?/g, "\n").split("\n")) {
    if (!comment) {
      const delimiter = text.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
      if (fence) {
        if (
          delimiter &&
          delimiter[1]![0] === fence.marker &&
          delimiter[1]!.length >= fence.length &&
          /^[ \t]*$/.test(delimiter[2]!)
        )
          fence = undefined;
        out.push(text.replace(INVISIBLE, ""));
        continue;
      }
      if (
        delimiter &&
        (delimiter[1]![0] !== "`" || !delimiter[2]!.includes("`"))
      ) {
        fence = { marker: delimiter[1]![0]!, length: delimiter[1]!.length };
        out.push(text.replace(INVISIBLE, ""));
        continue;
      }
    }
    let line = "";
    let at = 0;
    while (at < text.length) {
      if (comment) {
        const end = text.indexOf("-->", at);
        if (end < 0) break;
        comment = false;
        at = end + 3;
        continue;
      }
      const open = text.indexOf("<!--", at);
      const tick = text.indexOf("`", at);
      if (tick >= 0 && (open < 0 || tick < open)) {
        // A code span shows its text as written, comment markers included.
        const run = /^`+/.exec(text.slice(tick))![0].length;
        const closing = new RegExp(`(?<!\`)\`{${run}}(?!\`)`, "g");
        closing.lastIndex = tick + run;
        const close = closing.exec(text);
        const end = close ? close.index + run : tick + run;
        line += text.slice(at, end);
        at = end;
        continue;
      }
      if (open < 0) {
        line += text.slice(at);
        break;
      }
      line += text.slice(at, open);
      comment = true;
      at = open + 4;
    }
    if (!line.trim() && text.trim()) continue;
    out.push(line.replace(INVISIBLE, "").replace(REFERENCE, "$1"));
  }
  return out.join("\n");
}
