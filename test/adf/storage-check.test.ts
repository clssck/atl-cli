import { describe, expect, test } from "bun:test";
import {
  adfHygiene,
  describeInventory,
  inventoryDelta,
  storageHygiene,
  storageInventory,
} from "../../src/adf/storage-check.ts";
import { parseAdfBody } from "../../src/adf/index.ts";

// Live read of page 4161586 (macros with ids, mention, date, links, adf-extension, images).
const RICH =
  '<h2>Rich ADF</h2><ac:structured-macro ac:name="note" ac:schema-version="1" ac:macro-id="67da668e-defb-4574-8fed-5a4522a98607"><ac:parameter ac:name="containerLevel">panel_c1</ac:parameter><ac:rich-text-body><p>Panel body <strong>bold</strong></p></ac:rich-text-body></ac:structured-macro><ac:structured-macro ac:name="expand" ac:schema-version="1" ac:macro-id="23079b82-6529-4e1e-98d1-991d638caf23"><ac:parameter ac:name="title">Expand title</ac:parameter><ac:rich-text-body><p>hidden text inside expand</p></ac:rich-text-body></ac:structured-macro><p>Mention <ac:link><ri:user ri:account-id="62a219658783e7006f627f3b" /></ac:link> status <ac:structured-macro ac:name="status" ac:schema-version="1" ac:macro-id="39fa120b-58be-449d-be01-eef04fd8a673"><ac:parameter ac:name="title">In progress</ac:parameter><ac:parameter ac:name="colour">Blue</ac:parameter></ac:structured-macro> date <time datetime="2026-11-16" /> card <a href="https://foldvarszki.atlassian.net/browse/KAN-7" data-card-appearance="inline">https://foldvarszki.atlassian.net/browse/KAN-7</a> emoji <ac:emoticon ac:name="blue-star" ac:emoji-shortname=":smile:" ac:emoji-fallback="😄" /></p><table data-layout="default"><tbody><tr><td><ac:structured-macro ac:name="code" ac:schema-version="1" ac:macro-id="205920d6-c741-41b7-bc06-42bd7bf45c07"><ac:parameter ac:name="language">js</ac:parameter><ac:plain-text-body><![CDATA[x | y\nz]]></ac:plain-text-body></ac:structured-macro></td></tr></tbody></table><ul><li><p>item</p><ac:structured-macro ac:name="code" ac:schema-version="1" ac:macro-id="9d26e0f0-b3e1-4269-8772-b05bf68f79f7"><ac:plain-text-body><![CDATA[code in item]]></ac:plain-text-body></ac:structured-macro></li></ul><ac:adf-extension><ac:adf-node type="decision-list"><ac:adf-attribute key="local-id">d1</ac:adf-attribute><ac:adf-node type="decision-item"><ac:adf-attribute key="local-id">d2</ac:adf-attribute><ac:adf-attribute key="state">DECIDED</ac:adf-attribute><ac:adf-content>We decided X</ac:adf-content></ac:adf-node></ac:adf-node><ac:adf-fallback><ul class="decision-list"><li>We decided X</li></ul></ac:adf-fallback></ac:adf-extension><ac:image ac:align="center" ac:layout="center" ac:alt="alt text" ac:src="https://e.com/i.png"><ri:url ri:value="https://e.com/i.png" /></ac:image><a href="https://foldvarszki.atlassian.net/browse/KAN-12" data-card-appearance="block">https://foldvarszki.atlassian.net/browse/KAN-12</a><hr /><ac:structured-macro ac:name="toc" ac:schema-version="1" ac:macro-id="b7201282-28bb-40c2-945b-da16c75a4c6c" /><ac:structured-macro ac:name="details" ac:schema-version="1" ac:macro-id="2f3f257a-9786-4933-bfeb-192f8de0ec2d"><ac:rich-text-body><p>bodied extension content</p></ac:rich-text-body></ac:structured-macro><p>end</p>';

// Live read of page 7831553: entities in text, tasks inside and outside a macro, a heading in a macro body.
const CHECKLIST =
  '<p>Release manager: D&oacute;ra Lengyel.</p><h2>Go-live checklist</h2><ac:task-list><ac:task><ac:task-id>1</ac:task-id><ac:task-status>complete</ac:task-status><ac:task-body>(Release) Freeze the release/4.2 branch</ac:task-body></ac:task><ac:task><ac:task-id>2</ac:task-id><ac:task-status>incomplete</ac:task-status><ac:task-body>(QA) Sign off the regression suite</ac:task-body></ac:task></ac:task-list><ac:structured-macro ac:name="expand" ac:schema-version="1" ac:macro-id="887f9b14-196b-4aaf-8fc6-0f72ec4d19d6"><ac:parameter ac:name="title">Show details</ac:parameter><ac:rich-text-body><h2>Post-launch follow-ups &amp; <em>notes</em></h2><ac:task-list><ac:task><ac:task-id>13</ac:task-id><ac:task-status>incomplete</ac:task-status><ac:task-body>(DBA) Archive old partitions</ac:task-body></ac:task></ac:task-list></ac:rich-text-body></ac:structured-macro>';

// Live read of page 7798785: a page link by title with a volatile version-at-save.
const LINKED =
  '<h2>Escalation</h2><p>follow the <ac:link><ri:page ri:content-title="atl smoke nm hell Vendor Escalation Matrix" ri:version-at-save="2" /><ac:plain-text-link-body><![CDATA[Vendor Escalation Matrix]]></ac:plain-text-link-body></ac:link>.</p>';

describe("storageInventory", () => {
  test("counts macros by name and ignores macro ids", () => {
    expect(storageInventory(RICH).macros).toEqual({
      note: 1,
      expand: 1,
      status: 1,
      code: 2,
      toc: 1,
      details: 1,
    });
  });

  test("collects mentions, dates, links (a href and ri:url), headings and adf nodes", () => {
    const inventory = storageInventory(RICH);
    expect(inventory.mentions).toEqual({ "62a219658783e7006f627f3b": 1 });
    expect(inventory.dates).toEqual({ "2026-11-16": 1 });
    expect(inventory.links).toEqual({
      "https://foldvarszki.atlassian.net/browse/KAN-7": 1,
      "https://foldvarszki.atlassian.net/browse/KAN-12": 1,
      "https://e.com/i.png": 1,
    });
    expect(inventory.headings).toEqual({ "h2 Rich ADF": 1 });
    expect(inventory.adfNodes).toEqual({ "decision-list": 1, "decision-item": 1 });
    expect(inventory.tasks).toBeUndefined();
    expect(inventory.layouts).toBeUndefined();
  });

  test("tasks and headings are read as text: tags dropped, entities decoded", () => {
    const inventory = storageInventory(CHECKLIST);
    expect(inventory.headings).toEqual({
      "h2 Go-live checklist": 1,
      "h2 Post-launch follow-ups & notes": 1,
    });
    expect(inventory.tasks).toEqual({
      "(Release) Freeze the release/4.2 branch": 1,
      "(QA) Sign off the regression suite": 1,
      "(DBA) Archive old partitions": 1,
    });
  });

  test("page links name the title, with the space key when present; version-at-save is ignored", () => {
    expect(storageInventory(LINKED).pageLinks).toEqual({
      "atl smoke nm hell Vendor Escalation Matrix": 1,
    });
    expect(
      storageInventory(
        '<ac:link><ri:page ri:space-key="ENG" ri:content-title="Runbook &amp; Co" /></ac:link>',
      ).pageLinks,
    ).toEqual({ "ENG:Runbook & Co": 1 });
  });

  test("attachments and layout sections", () => {
    const xhtml =
      '<ac:layout><ac:layout-section ac:type="two_equal" ac:breakout-mode="default"><ac:layout-cell><p>a</p></ac:layout-cell></ac:layout-section><ac:layout-section ac:type="single"><ac:layout-cell><ac:image><ri:attachment ri:filename="expense form (final).png" ri:version-at-save="1" /></ac:image></ac:layout-cell></ac:layout-section></ac:layout>';
    const inventory = storageInventory(xhtml);
    expect(inventory.layouts).toEqual({ two_equal: 1, single: 1 });
    expect(inventory.attachments).toEqual({ "expense form (final).png": 1 });
  });

  test("a body with none of these has an empty inventory", () => {
    expect(storageInventory("<p>plain <strong>text</strong></p>")).toEqual({});
  });
});

describe("inventoryDelta", () => {
  test("a removed macro and heading appear under removed, new content under added", () => {
    const after = RICH.replace("<h2>Rich ADF</h2>", "<h3>Fresh</h3>").replace(
      /<ac:structured-macro ac:name="toc"[^>]*\/>/,
      "",
    );
    expect(inventoryDelta(storageInventory(RICH), storageInventory(after))).toEqual({
      removed: { macros: { toc: 1 }, headings: { "h2 Rich ADF": 1 } },
      added: { headings: { "h3 Fresh": 1 } },
    });
  });

  test("multiset counts: dropping one of two code macros removes one", () => {
    const after = RICH.replace(
      /<ac:structured-macro ac:name="code"[\s\S]*?<\/ac:structured-macro>/,
      "",
    );
    expect(inventoryDelta(storageInventory(RICH), storageInventory(after)).removed).toEqual({
      macros: { code: 1 },
    });
  });

  test("regenerated macro ids and version-at-save are not changes", () => {
    const after = RICH.replaceAll(/ac:macro-id="[^"]+"/g, 'ac:macro-id="fresh"');
    expect(inventoryDelta(storageInventory(RICH), storageInventory(after))).toEqual({
      removed: {},
      added: {},
    });
    expect(
      inventoryDelta(storageInventory(LINKED), storageInventory(LINKED.replace('"2"', '"9"'))),
    ).toEqual({ removed: {}, added: {} });
  });

  test("describeInventory lists categories with counts and cuts long lists", () => {
    expect(describeInventory({ macros: { toc: 1, code: 2 }, headings: { "h2 A": 1 } })).toBe(
      "macros: toc, code x2; headings: h2 A",
    );
    const many = Object.fromEntries(Array.from({ length: 13 }, (_, i) => [`h2 ${i}`, 1]));
    expect(describeInventory({ headings: many })).toContain("+3 more");
  });
});

describe("storageHygiene", () => {
  test("flags script and style elements and data:/file: URLs in href, src and ri:url", () => {
    expect(
      storageHygiene(
        '<script type="x">1</script><STYLE>p{}</STYLE><a href="data:text/html,x">a</a><img src=\'file:///etc/passwd\' /><ri:url ri:value="DATA:image/png;base64,AA" />',
      ),
    ).toEqual([
      "<script>",
      "<style>",
      "data: URL in href",
      "file: URL in src",
      "data: URL in ri:url",
    ]);
  });

  test("entity-encoded schemes and embedded whitespace do not slip through", () => {
    expect(
      storageHygiene('<a href="&#100;ata:text/html,x">a</a><a href=" fi&#10;le:///x">b</a>'),
    ).toEqual(["data: URL in href", "file: URL in href"]);
  });

  test("real content passes: https links, CDATA code, escaped markup, data: inside a path", () => {
    expect(storageHygiene(RICH)).toEqual([]);
    expect(
      storageHygiene(
        '<ac:plain-text-body><![CDATA[<script>alert(1)</script>]]></ac:plain-text-body><p>&lt;style&gt;</p><a href="https://e.com/data:x">a</a><a href="/wiki/file:x">b</a>',
      ),
    ).toEqual([]);
  });
});

describe("adfHygiene", () => {
  test("flags data:/file: in link marks and media, inlineCard and embedCard urls", () => {
    const doc = parseAdfBody(
      JSON.stringify({
        type: "doc",
        version: 1,
        content: [
          {
            type: "paragraph",
            content: [
              {
                type: "text",
                text: "a",
                marks: [{ type: "link", attrs: { href: "data:text/html,x" } }],
              },
              { type: "inlineCard", attrs: { url: "file:///etc/hosts" } },
            ],
          },
          { type: "embedCard", attrs: { url: "data:text/html,y" } },
          {
            type: "mediaSingle",
            content: [{ type: "media", attrs: { type: "external", url: "file:///x" } }],
          },
        ],
      }),
    );
    expect(adfHygiene(doc)).toEqual([
      "data: URL in link href",
      "file: URL in inlineCard url",
      "data: URL in embedCard url",
      "file: URL in media url",
    ]);
  });

  test("https links and script text are fine in ADF", () => {
    const doc = parseAdfBody(
      JSON.stringify({
        type: "doc",
        version: 1,
        content: [
          {
            type: "paragraph",
            content: [
              {
                type: "text",
                text: "<script>x</script>",
                marks: [{ type: "link", attrs: { href: "https://e.com" } }],
              },
            ],
          },
        ],
      }),
    );
    expect(adfHygiene(doc)).toEqual([]);
  });
});
