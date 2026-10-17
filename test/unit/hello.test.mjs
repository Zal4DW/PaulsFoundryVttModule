import { describe, expect, it } from "vitest";
import { greetingContent, isHelloCommand } from "../../scripts/lib/hello.mjs";

// Stand-in for foundry.utils.escapeHTML, which is not available in Node.
const escape = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

describe("isHelloCommand", () => {
  it.each(["/hello", "/HELLO", "  /hello  ", "/Hello\n"])("accepts %j", (input) => {
    expect(isHelloCommand(input)).toBe(true);
  });

  it.each(["hello", "/hello there", "/hellos", "", "/roll 1d20"])("rejects %j", (input) => {
    expect(isHelloCommand(input)).toBe(false);
  });

  it("rejects non-strings", () => {
    expect(isHelloCommand(undefined)).toBe(false);
    expect(isHelloCommand(null)).toBe(false);
    expect(isHelloCommand(42)).toBe(false);
  });
});

describe("greetingContent", () => {
  it("wraps the text in the module markup", () => {
    expect(greetingContent("Hi", escape)).toBe('<p class="pfm-message">Hi</p>');
  });

  it("passes the text through the escaper", () => {
    expect(greetingContent("<script>x</script>", escape)).toBe(
      '<p class="pfm-message">&lt;script&gt;x&lt;/script&gt;</p>'
    );
  });
});
