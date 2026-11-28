/** Text normalization shared by search, phrase matching and validation. */
/** Articles are dropped before phrase matching: BAL adds them freely ("the credit score of 'the borrower'"). */
export const ARTICLES = new Set([
    "the",
    "a",
    "an",
    // French: definite, indefinite and partitive articles (BAL inserts them around {this,PARTITIVE_ARTICLE})
    "le",
    "la",
    "les",
    "l",
    "un",
    "une",
    "des",
    "du",
    "de",
    "d",
    // Portuguese and Spanish (contractions with de / a / em / por included; "no" is left out, it is an English keyword)
    "o",
    "os",
    "as",
    "um",
    "uma",
    "uns",
    "umas",
    "do",
    "da",
    "dos",
    "das",
    "na",
    "nos",
    "nas",
    "ao",
    "aos",
    "pelo",
    "pela",
    "pelos",
    "pelas",
    "el",
    "los",
    "las",
    "unos",
    "unas",
    "del",
    "al",
]);
/**
 * Words of a text for phrase matching, with articles removed. A bare capital
 * `A` is kept: in ODM it is usually a domain value (`the grade is A`), not an article.
 */
export function phraseWords(text) {
    const out = [];
    // Apostrophes separate words (`l'âge` -> `l`, `âge`), as the BAL tokenizer does.
    for (const raw of text.split(/[^A-Za-z0-9\u00C0-\u024F]+/)) {
        if (!raw)
            continue;
        const isArticle = ARTICLES.has(raw.toLowerCase()) && raw !== "A";
        if (isArticle)
            continue;
        for (const word of normalize(raw).split(" "))
            if (word)
                out.push(word);
    }
    return out;
}
const STOP = new Set("a an the of to is in on for and or if then else with than be when should must from by at as that this into are was were will can may it its".split(" "));
export function normalize(value) {
    return value
        .normalize("NFKD")
        .replace(/[̀-ͯ]/g, "")
        .toLowerCase()
        .replace(/['’"]/g, "")
        .replace(/[^a-z0-9]+/g, " ")
        .trim();
}
/** Light English stemmer: enough for plural and tense variants, deterministic and explainable. */
export function stem(token) {
    if (token.length <= 3 || /^\d/.test(token))
        return token;
    const rules = [
        [/ies$/, "y"],
        [/(ss|us)$/, "$1"],
        [/([^s])s$/, "$1"],
        [/eed$/, "eed"],
        [/([a-z]{3,})ed$/, "$1"],
        [/([a-z]{3,})ing$/, "$1"],
    ];
    for (const [re, to] of rules) {
        if (re.test(token)) {
            let out = token.replace(re, to);
            // reject+ed -> reject, approv+ed -> approv (also what "approve" stems to below)
            out = out.replace(/e$/, "");
            return out;
        }
    }
    return token.replace(/e$/, "");
}
/** Search tokens: normalized, stemmed, stop words removed. */
export function searchTokens(value) {
    const out = [];
    for (const raw of normalize(value).split(" ")) {
        if (!raw || STOP.has(raw))
            continue;
        out.push(stem(raw));
    }
    return out;
}
/** Damerau–Levenshtein distance with an early exit above `max`. */
export function editDistance(a, b, max = 2) {
    if (a === b)
        return 0;
    if (Math.abs(a.length - b.length) > max)
        return max + 1;
    const rows = a.length + 1;
    const cols = b.length + 1;
    const d = Array.from({ length: rows }, () => new Array(cols).fill(0));
    for (let i = 0; i < rows; i++)
        d[i][0] = i;
    for (let j = 0; j < cols; j++)
        d[0][j] = j;
    for (let i = 1; i < rows; i++) {
        let rowMin = Infinity;
        for (let j = 1; j < cols; j++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            let value = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
            if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1])
                value = Math.min(value, d[i - 2][j - 2] + 1);
            d[i][j] = value;
            if (value < rowMin)
                rowMin = value;
        }
        if (rowMin > max)
            return max + 1;
    }
    return d[a.length][b.length];
}
/** Typo tolerance scales with word length so short words must match exactly. */
export function fuzzyLimit(token) {
    if (token.length <= 3)
        return 0;
    if (token.length <= 6)
        return 1;
    return 2;
}
/** Split camelCase / snake_case identifiers into words: `yearlyIncome` -> `yearly income`. */
export function splitIdentifier(name) {
    return name
        .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
        .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
        .replace(/[_$]+/g, " ")
        .toLowerCase()
        .trim();
}
/** Workspace-relative path with forward slashes, for ids that must not change between Windows and macOS. */
export function portablePath(value) {
    return value.replace(/\\/g, "/").replace(/^\.\//, "");
}
