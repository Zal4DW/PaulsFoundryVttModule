import { describe, expect, it } from "vitest";
import { greetingContent, HELLO_PATTERN, isHelloCommand } from "../../scripts/lib/hello.mjs";

// Stand-in for foundry.utils.escapeHTML, which is not available in Node.
const escape = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

describe("isHelloCommand", () => {
  // v14's ProseMirror chat box sends HTML.
  it.each(["/hello", "/HELLO", "  /hello  ", "/Hello\n", "<p>/hello</p>", "<p>/hello<br></p>"])("accepts %j", (input) => {
    expect(isHelloCommand(input)).toBe(true);
  });

  it.each(["hello", "/hello there", "/hellos", "", "/roll 1d20", "<p>/hello there</p>"])("rejects %j", (input) => {
    expect(isHelloCommand(input)).toBe(false);
  });

  it("rejects non-strings", () => {
    expect(isHelloCommand(undefined)).toBe(false);
    expect(isHelloCommand(null)).toBe(false);
    expect(isHelloCommand(42)).toBe(false);
  });
});

describe("HELLO_PATTERN", () => {
  // ChatLog.parse strips the outer <p> and tests this against what is left.
  it.each(["/hello", "/HELLO", "/hello "])("matches %j", (input) => {
    expect(HELLO_PATTERN.test(input)).toBe(true);
  });

  it.each(["/hello there", "/hellos", "hello", " /hello"])("does not match %j", (input) => {
    expect(HELLO_PATTERN.test(input)).toBe(false);
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
