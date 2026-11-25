import assert from "node:assert/strict";
import { test } from "node:test";
import { parseVoc, vocLocale } from "../src/parse/voc.ts";

test("entries, escapes, continuations, locale from the file name", () => {
  const voc = parseVoc(
    `# comment
uuid = abc
com.acme.Borrower#concept.label = borrower
com.acme.Borrower.creditScore#phrase.navigation = {score de cr\\u00e9dit} de {this}
com.acme.Loan.addToMessages(java.lang.String)#phrase.action = add {0} \\
    to the messages of {this}
com.acme.Loan#odd.key = kept
`,
    { project: "P", path: "bom/model_fr_FR.voc" },
  );
  assert.equal(voc.uuid, "abc");
  assert.equal(voc.locale, "fr_FR");
  assert.equal(voc.entries.length, 4);
  assert.equal(voc.entries[1].value, "{score de crédit} de {this}");
  assert.equal(voc.entries[2].owner, "com.acme.Loan.addToMessages(java.lang.String)");
  assert.equal(voc.entries[2].value, "add {0} to the messages of {this}");
  assert.equal(voc.warnings.length, 1, "unknown key is noted");
});

test("locale suffixes", () => {
  assert.equal(vocLocale("bom/model_en.voc"), "en");
  assert.equal(vocLocale("bom/model_en_US.voc"), "en_US");
  assert.equal(vocLocale("bom/model.voc"), undefined);
});
