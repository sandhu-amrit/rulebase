/**
 * The accuracy suite: phrases an assistant would send, and what Rulebase must say.
 * These are the cases the old pipeline got wrong (11/11 false rejects, 2/7 false accepts).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { built, MINILOAN } from "./helpers.ts";

const { kb } = built(MINILOAN);
const check = (phrase: string) => kb.validatePhrases({ phrases: [phrase] }).results[0] as { ok: boolean; unknownWords?: string[]; typeErrors?: string[] };

const VALID = [
  "the credit score of the borrower is less than 300",
  "the credit score of 'the borrower' is at least 600",
  "reject the loan",
  "the yearly income of the borrower is at least 10000",
  "the yearly repayment of the loan is more than the yearly income of the borrower * 0.4",
  "add \"Debt too high\" to the messages of the loan",
  "the amount of the loan is more than 1000000",
  "the duration of the loan is between 12 and 360",
  "the loan is approved",
  "set the credit score of the borrower to 700",
  "make it false that the loan is approved",
];

for (const phrase of VALID) {
  test(`accepts: ${phrase}`, () => {
    const result = check(phrase);
    assert.ok(result.ok, JSON.stringify(result));
  });
}

const INVALID: [string, RegExp][] = [
  ["set the credit score of the loan to the name of the borrower", /belongs to borrower/],
  ["reject the borrower", /belongs to loan/],
  ["the credit score of the borrower is less than \"abc\"", /compared with the text/],
  ["the name of the borrower is less than 5", /compares numbers/],
];
for (const [phrase, why] of INVALID) {
  test(`rejects a type error: ${phrase}`, () => {
    const result = check(phrase);
    assert.equal(result.ok, false);
    assert.match((result.typeErrors ?? []).join("\n"), why);
  });
}

const UNKNOWN: [string, string[]][] = [
  ["the vibe score of the applicant is low", ["vibe", "applicant", "low"]],
  ["the employment status of the borrower is unemployed", ["employment", "status", "unemployed"]],
  ["the age of the borrower is less than 18", ["age"]],
];
for (const [phrase, words] of UNKNOWN) {
  test(`rejects unknown vocabulary: ${phrase}`, () => {
    const result = check(phrase);
    assert.equal(result.ok, false);
    for (const word of words) assert.ok(result.unknownWords?.includes(word), `${word} in ${JSON.stringify(result.unknownWords)}`);
  });
}

test("a missing term becomes a vocabulary gap, not a silent miss", () => {
  const result = kb.findChangeCandidates({ terms: ["the employment type of the borrower", "the yearly income of the borrower"] });
  assert.deepEqual(result.vocabularyGaps.map((gap) => gap.term), ["the employment type of the borrower"]);
  assert.ok(result.modify.length > 0);
});

/** Labelled requirements: the terms an assistant grounds, and the rules that should change. */
const REQUIREMENTS = [
  {
    requirement: "Decline applicants whose debt-to-income is above 40%",
    terms: ["the yearly repayment of the loan", "the yearly income of the borrower"],
    expect: ["minimum income", "repayment and score"],
  },
  {
    requirement: "Raise the minimum credit score to 250",
    terms: ["the credit score of the borrower"],
    expect: ["minimum credit score", "repayment and score"],
  },
  {
    requirement: "Cap loans at 500,000",
    terms: ["the amount of the loan"],
    expect: ["maximum amount"],
  },
];
for (const item of REQUIREMENTS) {
  test(`candidates: ${item.requirement}`, () => {
    const result = kb.findChangeCandidates({ terms: item.terms, requirement: item.requirement });
    const names = result.modify.map((candidate) => candidate.name);
    assert.deepEqual([...names].sort(), [...item.expect].sort());
    assert.equal(result.vocabularyGaps.length, 0);
    assert.ok(result.add.length > 0, "suggests where a new rule would go");
  });
}
