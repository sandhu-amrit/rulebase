/**
 * BM25 over an inverted index, with typo-tolerant query expansion.
 * Deterministic: equal scores are ordered by document key.
 */
import { editDistance, fuzzyLimit, searchTokens } from "./text.js";
const K1 = 1.2;
const B = 0.75;
export class SearchIndex {
    postings = new Map();
    lengths = [];
    keys = [];
    byLength = new Map();
    avgdl = 1;
    constructor(docs) {
        docs.forEach((doc, index) => {
            this.keys.push(doc.key);
            let length = 0;
            for (const field of doc.fields) {
                for (const token of searchTokens(field.text)) {
                    let posting = this.postings.get(token);
                    if (!posting) {
                        posting = new Map();
                        this.postings.set(token, posting);
                    }
                    posting.set(index, (posting.get(index) ?? 0) + field.weight);
                    length += 1;
                }
            }
            this.lengths.push(length || 1);
        });
        this.avgdl = this.lengths.reduce((sum, value) => sum + value, 0) / (this.lengths.length || 1);
        for (const token of this.postings.keys()) {
            const list = this.byLength.get(token.length) ?? [];
            list.push(token);
            this.byLength.set(token.length, list);
        }
    }
    get size() {
        return this.keys.length;
    }
    /** Index tokens within the typo limit of a query token (exact match first). */
    expand(token) {
        if (this.postings.has(token))
            return [{ term: token, penalty: 1 }];
        const limit = fuzzyLimit(token);
        if (!limit)
            return [];
        const out = [];
        for (let len = token.length - limit; len <= token.length + limit; len++) {
            for (const candidate of this.byLength.get(len) ?? []) {
                const distance = editDistance(token, candidate, limit);
                if (distance <= limit)
                    out.push({ term: candidate, penalty: distance === 1 ? 0.7 : 0.5 });
            }
        }
        // Prefix match helps with truncated words ("elig" -> "eligibility") without being fuzzy noise.
        if (!out.length && token.length >= 4) {
            for (const candidate of this.postings.keys()) {
                if (candidate.startsWith(token))
                    out.push({ term: candidate, penalty: 0.6 });
            }
        }
        return out;
    }
    search(query, options = {}) {
        const tokens = [...new Set(searchTokens(query))];
        const scores = new Map();
        const matched = new Map();
        const n = this.keys.length;
        for (const token of tokens) {
            for (const { term, penalty } of this.expand(token)) {
                const posting = this.postings.get(term);
                if (!posting)
                    continue;
                const idf = Math.log(1 + (n - posting.size + 0.5) / (posting.size + 0.5));
                for (const [doc, tf] of posting) {
                    const length = this.lengths[doc];
                    const score = (penalty * idf * (tf * (K1 + 1))) / (tf + K1 * (1 - B + (B * length) / this.avgdl));
                    scores.set(doc, (scores.get(doc) ?? 0) + score);
                    const list = matched.get(doc) ?? [];
                    if (!list.some((item) => item.query === token))
                        list.push({ query: token, term });
                    matched.set(doc, list);
                }
            }
        }
        const results = [];
        for (const [doc, score] of scores) {
            const key = this.keys[doc];
            if (options.filter && !options.filter(key))
                continue;
            results.push({ key, score, matched: matched.get(doc) ?? [] });
        }
        results.sort((a, b) => b.score - a.score || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
        return results.slice(0, options.limit ?? 20);
    }
}
