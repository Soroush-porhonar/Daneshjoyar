/**
 * Bale shows LaTeX as raw text ("$\sqrt{\frac{1}{n}}$"), and the model writes
 * formulas that way despite the prompt. This turns the math the model
 * delimits ($...$, $$...$$, \(...\), \[...\]) into plain Unicode
 * ("√(1/n)"). Text outside the delimiters is left alone, so code
 * ("file_name", "a^b") and prices are never changed; code blocks and inline
 * code are skipped even when they contain dollar signs.
 */

const SYMBOLS: Record<string, string> = {
  sum: "Σ", prod: "Π", int: "∫", partial: "∂", nabla: "∇", infty: "∞",
  times: "×", cdot: "·", div: "÷", pm: "±", mp: "∓",
  leq: "≤", le: "≤", geq: "≥", ge: "≥", neq: "≠", ne: "≠", approx: "≈", equiv: "≡", sim: "∼",
  to: "→", rightarrow: "→", leftarrow: "←", Rightarrow: "⇒", Leftrightarrow: "⇔", mapsto: "↦",
  in: "∈", notin: "∉", subset: "⊂", subseteq: "⊆", cup: "∪", cap: "∩", emptyset: "∅",
  forall: "∀", exists: "∃", neg: "¬", land: "∧", lor: "∨", ldots: "…", cdots: "⋯", dots: "…",
  alpha: "α", beta: "β", gamma: "γ", delta: "δ", epsilon: "ε", varepsilon: "ε", zeta: "ζ",
  eta: "η", theta: "θ", lambda: "λ", mu: "μ", nu: "ν", xi: "ξ", pi: "π", rho: "ρ",
  sigma: "σ", tau: "τ", phi: "φ", varphi: "φ", chi: "χ", psi: "ψ", omega: "ω",
  Gamma: "Γ", Delta: "Δ", Theta: "Θ", Lambda: "Λ", Pi: "Π", Sigma: "Σ", Phi: "Φ", Omega: "Ω",
  log: "log", ln: "ln", exp: "exp", sin: "sin", cos: "cos", tan: "tan", min: "min", max: "max",
  lim: "lim", arg: "arg", det: "det", mod: "mod",
  left: "", right: "", displaystyle: "", limits: "", quad: " ", qquad: " ",
};

const SUPERSCRIPT: Record<string, string> = {
  "0": "⁰", "1": "¹", "2": "²", "3": "³", "4": "⁴", "5": "⁵", "6": "⁶", "7": "⁷", "8": "⁸", "9": "⁹",
  "+": "⁺", "-": "⁻", "=": "⁼", "(": "⁽", ")": "⁾", n: "ⁿ", i: "ⁱ", T: "ᵀ", k: "ᵏ", m: "ᵐ", x: "ˣ",
};

const SUBSCRIPT: Record<string, string> = {
  "0": "₀", "1": "₁", "2": "₂", "3": "₃", "4": "₄", "5": "₅", "6": "₆", "7": "₇", "8": "₈", "9": "₉",
  "+": "₊", "-": "₋", "=": "₌", "(": "₍", ")": "₎", a: "ₐ", e: "ₑ", h: "ₕ", i: "ᵢ", j: "ⱼ", k: "ₖ",
  l: "ₗ", m: "ₘ", n: "ₙ", o: "ₒ", p: "ₚ", r: "ᵣ", s: "ₛ", t: "ₜ", u: "ᵤ", v: "ᵥ", x: "ₓ",
};

/** Accents written as a combining mark after the letter: \hat{y} -> ŷ. */
const ACCENTS: Record<string, string> = { hat: "̂", widehat: "̂", bar: "̄", overline: "̄", tilde: "̃", vec: "⃗", dot: "̇" };

/** Commands whose argument is kept as it is: \text{mean} -> mean (so is any unknown command's). */
const KEEP_ARGUMENT = ["text", "mathrm", "mathbf", "mathit", "mathbb", "mathcal", "operatorname", "boldsymbol"];

/** "x" stays x; "x+1" becomes (x+1), so a fraction or root reads right. */
const group = (text: string): string => (/^[\p{L}\p{N}.]+$/u.test(text.trim()) ? text.trim() : `(${text.trim()})`);

/** ^{n} -> ⁿ when every character has a superscript form, else ^(n+k). */
function script(text: string, table: Record<string, string>, mark: string): string {
  const chars = [...text.replace(/\s+/g, "")];
  return chars.every((char) => table[char]) ? chars.map((char) => table[char]).join("") : `${mark}${group(text)}`;
}

/** One math expression, from its LaTeX to Unicode. */
export function latexToUnicode(math: string): string {
  let text = math;
  // Innermost braces first, so nested commands resolve from the inside out.
  for (let pass = 0; pass < 10; pass++) {
    const before = text;
    text = text
      .replace(/\\[dt]?frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, (_, a: string, b: string) => `${group(a)}/${group(b)}`)
      .replace(/\\sqrt\s*\[([^\]]*)\]\s*\{([^{}]*)\}/g, (_, n: string, x: string) => `${script(n, SUPERSCRIPT, "^")}√${group(x)}`)
      .replace(/\\sqrt\s*\{([^{}]*)\}/g, (_, x: string) => `√${group(x)}`)
      .replace(/\\binom\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, (_, n: string, k: string) => `C(${n.trim()}, ${k.trim()})`)
      .replace(/\\([A-Za-z]+)\s*\{([^{}]*)\}/g, (whole, name: string, argument: string) => {
        if (ACCENTS[name]) return `${argument.trim()}${ACCENTS[name]}`;
        if (KEEP_ARGUMENT.includes(name) || !(name in SYMBOLS)) return argument;
        return whole;
      })
      .replace(/\^\s*\{([^{}]*)\}/g, (_, x: string) => script(x, SUPERSCRIPT, "^"))
      .replace(/_\s*\{([^{}]*)\}/g, (_, x: string) => script(x, SUBSCRIPT, "_"));
    if (text === before) break;
  }

  return text
    .replace(/\\sqrt\s*(\w)/g, "√$1")
    .replace(/\\([A-Za-z]+)\s+([\p{L}\p{N}])/gu, (whole, name: string, letter: string) =>
      ACCENTS[name] ? `${letter}${ACCENTS[name]}` : whole,
    )
    .replace(/\\([A-Za-z]+)/g, (whole, name: string) => SYMBOLS[name] ?? whole)
    .replace(/\\[,;:! ]/g, " ")
    .replace(/\^\s*([\p{L}\p{N}+\-])/gu, (_, x: string) => script(x, SUPERSCRIPT, "^"))
    .replace(/_\s*([\p{L}\p{N}])/gu, (_, x: string) => script(x, SUBSCRIPT, "_"))
    .replace(/[{}]/g, "")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

/** Delimited math: $$..$$, \[..\], \(..\), and $..$ that looks like math (not "$5 and $10"). */
const MATH = /\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]|\\\(([\s\S]+?)\\\)|\$([^$\n]+?)\$/g;
const LOOKS_LIKE_MATH = /[\\^_{}=]/;

/** Code blocks and inline code are copied unchanged. */
const CODE = /(```[\s\S]*?```|`[^`\n]*`)/;

export function plainMath(text: string): string {
  return text
    .split(CODE)
    .map((part, index) =>
      index % 2 === 1
        ? part
        : part.replace(MATH, (whole, display?: string, bracket?: string, paren?: string, inline?: string) => {
            if (inline !== undefined && !LOOKS_LIKE_MATH.test(inline)) return whole;
            return latexToUnicode(display ?? bracket ?? paren ?? inline ?? "");
          }),
    )
    .join("");
}
