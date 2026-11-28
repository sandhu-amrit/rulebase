import assert from "node:assert/strict";
import { test } from "node:test";
import { compilePattern, tokenizeBal } from "../src/bal.ts";
import { stem } from "../src/text.ts";

test("tokenizer: variables, literals, placeholders, articles dropped", () => {
  const tokens = tokenizeBal(
    `the credit score of 'the borrower' is at least <min> and "x; y" < 3.5`,
  );
  assert.deepEqual(
    tokens.map((token) => `${token.kind}:${token.value}`),
    [
      "word:credit",
      "word:score",
      "word:of",
      "var:borrower",
      "word:is",
      "word:at",
      "word:least",
      "placeholder:min",
      "word:and",
      "string:x; y",
      "op:<",
      "number:3.5",
    ],
  );
});

test("a capital A is a value, a lower-case a is an article", () => {
  assert.deepEqual(
    tokenizeBal("the grade is A").map((token) => token.value),
    ["grade", "is", "a"],
  );
  assert.deepEqual(
    tokenizeBal("set it to a borrower").map((token) => token.value),
    ["set", "it", "to", "borrower"],
  );
});

test("patterns: {this} and {0} are slots, other braces are words, setter value is a slot", () => {
  assert.deepEqual(compilePattern("{credit score} of {this}").items, [
    { lit: "credit" },
    { lit: "score" },
    { lit: "of" },
    { slot: 0 },
  ]);
  assert.deepEqual(compilePattern("add {0} to the messages of {this}").slotNames, ["0", "this"]);
  const setter = compilePattern("set the credit score of {this} to {credit score}", "credit score");
  assert.deepEqual(setter.slotNames, ["this", "credit score"]);
});

test("stemmer folds plurals and tenses together", () => {
  assert.equal(stem("rejected"), stem("reject"));
  assert.equal(stem("approved"), stem("approve"));
  assert.equal(stem("scores"), stem("score"));
  assert.equal(stem("policies"), stem("policy"));
  assert.equal(stem("status"), "status");
});
