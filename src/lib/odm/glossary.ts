import type { GlossaryEntry } from "./types.ts";

/** Curated business language → fragments of formal vocabulary. */
export const CURATED_GLOSSARY: GlossaryEntry[] = [
  { phrase: "over-leveraged", mapsTo: ["yearly repayment", "yearly income"], source: "curated" },
  { phrase: "over leveraged", mapsTo: ["yearly repayment", "yearly income"], source: "curated" },
  { phrase: "high dti", mapsTo: ["yearly repayment", "yearly income"], source: "curated" },
  { phrase: "dti", mapsTo: ["yearly repayment", "yearly income"], source: "curated" },
  { phrase: "debt to income", mapsTo: ["yearly repayment", "yearly income"], source: "curated" },
  { phrase: "debt ratio", mapsTo: ["yearly repayment", "yearly income"], source: "curated" },
  { phrase: "debt-to-income", mapsTo: ["yearly repayment", "yearly income"], source: "curated" },
  { phrase: "credit score", mapsTo: ["credit score"], source: "curated" },
  { phrase: "too much debt", mapsTo: ["yearly repayment", "yearly income"], source: "curated" },
  { phrase: "cannot afford", mapsTo: ["yearly repayment", "yearly income"], source: "curated" },
];
