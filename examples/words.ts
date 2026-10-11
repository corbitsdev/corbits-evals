// Content words for the keyword-overlap baselines in the ports.
const STOPWORDS = new Set(
  "a,an,the,and,or,but,if,then,else,for,to,of,in,on,at,by,with,from,as,is,are,was,were,be,been,being,it,its,this,that,these,those,i,you,he,she,we,they,them,his,her,our,their,my,your,me,him,us,do,does,did,have,has,had,will,would,can,could,should,may,might,must,not,no,yes,so,than,too,very,just,also,there,here,when,where,which,who,whom,what,how,why,because,while,until,into,over,after,before,between,through,during,each,other,some,any,such,only,own,same".split(
    ",",
  ),
);

/** Unicode-aware; numerals are kept because "3-5 days" numbers matter in evals. */
export function contentWords(text: string): string[] {
  const seen = new Set<string>();
  for (const token of text
    .normalize("NFKC")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)) {
    if (token === "" || STOPWORDS.has(token)) continue;
    seen.add(token);
  }
  return [...seen];
}

/** Fraction of the reference's content words present in the output. */
export function coverage(reference: string, output: string): number {
  const want = contentWords(reference);
  if (want.length === 0) return 0;
  const have = new Set(contentWords(output));
  return want.filter((w) => have.has(w)).length / want.length;
}
