// Pure helpers with no Foundry globals, so Vitest can test them in Node.

export const HELLO_COMMAND = "/hello";

/** True when a raw chat string is the /hello command. */
export function isHelloCommand(message) {
  if (typeof message !== "string") return false;
  return message.trim().toLowerCase() === HELLO_COMMAND;
}

/** Wrap greeting text in the module's message markup. The caller supplies the HTML escaper. */
export function greetingContent(text, escape) {
  return `<p class="pfm-message">${escape(String(text))}</p>`;
}
