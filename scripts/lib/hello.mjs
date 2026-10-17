// Pure helpers with no Foundry globals, so Vitest can test them in Node.

export const HELLO_COMMAND = "/hello";

/** Matches the command after Foundry's ChatLog.parse strips the <p> wrapper. Used as the CHAT_COMMANDS rgx. */
export const HELLO_PATTERN = /^\/hello\s*$/i;

/**
 * True when a chat string is the /hello command.
 * Foundry v14's chat box is a ProseMirror editor, so the text arrives as HTML such as "<p>/hello</p>".
 */
export function isHelloCommand(message) {
  if (typeof message !== "string") return false;
  return HELLO_PATTERN.test(message.replace(/<[^>]*>/g, "").trim());
}

/** Wrap greeting text in the module's message markup. The caller supplies the HTML escaper. */
export function greetingContent(text, escape) {
  return `<p class="pfm-message">${escape(String(text))}</p>`;
}
