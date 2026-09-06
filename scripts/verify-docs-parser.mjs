export const inlineMarkdownLinkPattern =
  /(!?)\[[^\]\n]*\]\(\s*(?:<([^>\n]+)>|((?:\\.|[^()\\\s]|\([^()\n]*\))+))(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)/gu;

export function stripHtmlTags(value) {
  let result = '';
  let insideTag = false;

  for (const character of value) {
    if (character === '<') {
      insideTag = true;
      continue;
    }
    if (insideTag) {
      if (character === '>') {
        insideTag = false;
      }
      continue;
    }
    result += character;
  }

  return result;
}
