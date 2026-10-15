import { describe, expect, it } from "vitest";
import { cookieHeaderFrom } from "../src/login.js";
import { stripQuoted } from "../src/format.js";
import { composeHtmlBody, htmlToText, textToHtml } from "../src/html.js";
import { redact, registerSecret } from "../src/redact.js";

describe("cookieHeaderFrom", () => {
  const cookies = "_ga=GA1; current_user_session_token=tok123; _jelly_session=sess456; ph_x=1";
  it("keeps only the login cookies from Copy as cURL", () => {
    expect(cookieHeaderFrom(`curl 'https://app.letsjelly.com/hack-club/inbox' \\\n  -H 'accept: text/html' \\\n  -b '${cookies}' \\\n  -H 'user-agent: x'`)).toBe(
      "current_user_session_token=tok123; _jelly_session=sess456",
    );
    expect(cookieHeaderFrom(`curl 'https://app.letsjelly.com/' -H 'cookie: ${cookies}'`)).toBe(
      "current_user_session_token=tok123; _jelly_session=sess456",
    );
  });
  it("takes a bare Cookie header too", () => {
    expect(cookieHeaderFrom(`Cookie: ${cookies}`)).toBe("current_user_session_token=tok123; _jelly_session=sess456");
  });
});

describe("html", () => {
  it("links addresses and sites like a person would", () => {
    expect(textToHtml("Write to help@example.org or see [the guide](https://example.org/g).\n\nThanks!")).toBe(
      '<div>Write to <a href="mailto:help@example.org">help@example.org</a> or see <a href="https://example.org/g">the guide</a>.</div><div><br></div><div>Thanks!</div>',
    );
  });
  it("puts the reply above the signature and quote", () => {
    expect(composeHtmlBody("Hi", '<br>\n<br>\n<div class="jelly-signature">Pat</div>')).toBe('<div>Hi</div><div class="jelly-signature">Pat</div>');
    expect(composeHtmlBody("Hi", '<blockquote>old</blockquote>')).toBe("<div>Hi</div><div><br></div><blockquote>old</blockquote>");
  });
  it("reads HTML back as text", () => {
    expect(htmlToText('<p>Hi&nbsp;there,<br></p><p>See <a href="https://example.org">example.org</a> or <a href="https://x.org/a">the form</a></p>')).toBe(
      "Hi there,\n\nSee example.org or [the form](https://x.org/a)",
    );
  });
  it("drops quoted history", () => {
    expect(stripQuoted("Sounds good!\n\nOn Tue, Oct 14, 2026 at 9:00 AM Pat <p@example.org>\nwrote:\n> earlier")).toBe("Sounds good!");
  });
});

describe("redact", () => {
  it("hides registered secrets and anything shaped like one", () => {
    registerSecret("tok123secret");
    expect(redact("cookie: tok123secret and Bearer mrmld_abcdef and x tok123secret")).not.toMatch(/tok123secret|mrmld_abcdef/);
  });
});
